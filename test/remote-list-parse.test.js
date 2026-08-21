// parseRemoteListOutput() — the framing parser between the remote POSIX-sh lister
// and the CLI-import picker.
//
// cli-import-remote.test.js drives this function through the real sh script, which
// only ever emits well-formed `FILE <size> <path>` headers. That leaves the parser's
// behaviour on MALFORMED framing completely untested — and the framing arrives over
// SSH from a host this process does not control, so "the script is correct" is not
// the same claim as "the parser is safe against what comes back".
//
// The function is not exported (server.js exports nothing — it is the entry point),
// so it is LIFTED out of the source and run for real, the way update-flow.test.js
// lifts parseCaskVersion() out of electron/main.js. No reimplementation: if the
// source changes, this file runs the change.
//
// Run: node test/remote-list-parse.test.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function check(label, actual, expected) {
  try { assert.deepStrictEqual(actual, expected); pass++; console.log(`  ok   ${label}`); }
  catch { fail++; console.error(`  FAIL ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}

// ── Lift the real function ───────────────────────────────────────────────────
const SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const start = SRC.indexOf('function parseRemoteListOutput(');
assert.notStrictEqual(start, -1, 'parseRemoteListOutput not found in server.js');
// Ends at the next top-level `function ` — every brace in between belongs to it.
const end = SRC.indexOf('\nfunction ', start + 1);
assert.notStrictEqual(end, -1, 'could not find the end of parseRemoteListOutput');
const src = SRC.slice(start, end);
check('the lifted source is the whole function', /return \{ base, status, files, count \};\s*\}\s*$/.test(src.trim()), true);
const parseRemoteListOutput = new Function(`${src}; return parseRemoteListOutput;`)();

const N = 'NONCE123';
const line = (...p) => `${N} ${p.join(' ')}`;

console.log('\n— well-formed framing (the positive control for everything below) —');
{
  const out = parseRemoteListOutput([
    line('BASE', '/home/u/.claude/projects'),
    line('FILE', '120', '.claude/projects/proj/a.jsonl'),
    '{"type":"user"}',
    '{"type":"assistant"}',
    line('ENDFILE'),
    line('DONE', '1'),
  ].join('\n'), N);
  check('base is read', out.base, '/home/u/.claude/projects');
  check('status is DONE', out.status, 'DONE');
  check('the count comes off the DONE line', out.count, 1);
  check('one file row', out.files.length, 1);
  check('its size is parsed', out.files[0].size, 120);
  check('its path keeps everything after the size', out.files[0].path, '.claude/projects/proj/a.jsonl');
  check('its body is the lines between FILE and ENDFILE',
    out.files[0].raw, '{"type":"user"}\n{"type":"assistant"}');
}

console.log('\n— a path containing spaces —');
{
  const out = parseRemoteListOutput([
    line('FILE', '9', '.claude/projects/my proj/two words.jsonl'),
    'x',
    line('ENDFILE'),
    line('DONE', '1'),
  ].join('\n'), N);
  // The size is split off on the FIRST space only; everything after it is the path.
  check('only the first space splits size from path',
    out.files.map(f => f.path), ['.claude/projects/my proj/two words.jsonl']);
  check('and the size is still right', out.files[0].size, 9);
}

console.log('\n— a FILE header with no path at all —');
// The regression this file was written for. `arg.indexOf(' ')` returns -1, and the
// old code sliced on it: arg.slice(0, -1) as the size and arg.slice(0) as the path,
// i.e. the size digits themselves rendered to the user as a filename, with a real
// body attached to it. The row is now dropped.
{
  const out = parseRemoteListOutput([
    line('FILE', '4096'),
    'body of a file that has no name',
    line('ENDFILE'),
    line('DONE', '1'),
  ].join('\n'), N);
  check('the nameless row is dropped, not invented', out.files, []);
  check('parsing continues to the DONE line', out.status, 'DONE');
}
{
  // And it must not swallow the file after it, nor graft its body onto the one before.
  const out = parseRemoteListOutput([
    line('FILE', '10', 'a.jsonl'),
    'AAA',
    line('ENDFILE'),
    line('FILE', '4096'),
    'orphan body',
    line('ENDFILE'),
    line('FILE', '20', 'b.jsonl'),
    'BBB',
    line('ENDFILE'),
    line('DONE', '3'),
  ].join('\n'), N);
  check('the two well-formed rows survive on either side of it',
    out.files.map(f => f.path), ['a.jsonl', 'b.jsonl']);
  check('the orphan body is not appended to the previous file',
    out.files.map(f => f.raw), ['AAA', 'BBB']);
  // The remote said 3; two arrived. The count is reported as sent so the caller can
  // see the discrepancy rather than having it smoothed over here.
  check('the remote count is passed through untouched', out.count, 3);
}

console.log('\n— an empty FILE header —');
{
  const out = parseRemoteListOutput([line('FILE'), 'junk', line('ENDFILE'), line('DONE', '1')].join('\n'), N);
  check('a bare FILE with no argument is dropped too', out.files, []);
}

console.log('\n— a non-numeric size —');
{
  const out = parseRemoteListOutput([line('FILE', 'huge', 'x.jsonl'), line('ENDFILE'), line('DONE', '1')].join('\n'), N);
  check('an unparseable size becomes 0, the row survives', out.files.map(f => [f.path, f.size]), [['x.jsonl', 0]]);
}

console.log('\n— error statuses stop the parse —');
check('NOCLAUDE is reported and nothing after it is read',
  parseRemoteListOutput([line('NOCLAUDE'), line('FILE', '1', 'x'), line('ENDFILE'), line('DONE', '1')].join('\n'), N),
  { base: null, status: 'NOCLAUDE', files: [], count: 0 });
check('NOBASE likewise',
  parseRemoteListOutput([line('NOBASE'), line('DONE', '9')].join('\n'), N).status, 'NOBASE');
check('an empty stdout is a null status, not a crash',
  parseRemoteListOutput('', N), { base: null, status: null, files: [], count: 0 });

console.log('\n— the nonce is what separates framing from payload —');
{
  // A transcript line that LOOKS like framing must not be treated as framing: the
  // remote picks a fresh nonce per call precisely so untrusted file content cannot
  // forge a header.
  const out = parseRemoteListOutput([
    line('FILE', '50', 'a.jsonl'),
    'OTHERNONCE ENDFILE',
    'FILE 1 /etc/passwd',
    line('ENDFILE'),
    line('DONE', '1'),
  ].join('\n'), N);
  check('a forged header inside a transcript stays payload', out.files.map(f => f.path), ['a.jsonl']);
  check('and is preserved verbatim in the body',
    out.files[0].raw, 'OTHERNONCE ENDFILE\nFILE 1 /etc/passwd');
}
{
  const out = parseRemoteListOutput([line('FILE', '1', 'a.jsonl'), line('ENDFILE'), line('DONE', '1')].join('\n'), 'WRONGNONCE');
  check('the wrong nonce parses nothing at all', out, { base: null, status: null, files: [], count: 0 });
}

console.log('\n— ENDFILE without an open file —');
check('a stray ENDFILE does not push an empty row',
  parseRemoteListOutput([line('ENDFILE'), line('DONE', '0')].join('\n'), N).files, []);
check('a FILE never closed by ENDFILE is not emitted',
  parseRemoteListOutput([line('FILE', '5', 'x.jsonl'), 'body'].join('\n'), N).files, []);

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
