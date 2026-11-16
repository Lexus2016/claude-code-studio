// GitHub #131, proposal 8 — answer buttons on the "Claude is waiting" banner.
//
// Three layers, each of which can send a digit to the wrong question on its own:
//   1. promptOptions() — which options are on screen, and a key naming the question.
//      Driven against the screens CAPTURED from CLI 2.1.311 (askuserquestion-*.txt):
//      a two-question AskUserQuestion, its question 2, its "Submit answers" screen,
//      and a single question. The key must change from question to question and must
//      NOT change when only the caret moves.
//   2. answerPrompt() — re-captures a REAL tmux pane and types one digit only if the
//      widget is still that question. A fake pane that records every byte it gets
//      proves both the positive case and that a stale, foreign or malformed answer
//      sends nothing at all.
//   3. The server wiring, pinned as source text (server.js cannot be required): the
//      open-prompt check comes before the pane is touched, and the engine re-announces
//      a prompt whose question changed in place.
//
// Self-skips the tmux part without tmux. Creates and kills only its own sessions on
// the studio socket — never kill-server, the socket is shared with live studios.
//
// Run: node test/prompt-answer.test.js
process.env.CCS_PROMPT_ANSWER_SETTLE_MS = '400';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { promptOptions, answerPrompt, paneAwaitingInput, tmuxName } = require('../claude-interactive');
const { createEnginePromptStore } = require('../engine-prompts');
const { TMUX_SOCKET } = require('../terminal-bridge');

let pass = 0, fail = 0;
function check(label, actual, expected) {
  try { assert.deepStrictEqual(actual, expected); pass++; console.log(`  ok   ${label}`); }
  catch { fail++; console.error(`  FAIL ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}
const FIX = path.join(__dirname, 'fixtures', 'claude-tui');
const read = (f) => fs.readFileSync(path.join(FIX, f), 'utf8');
const labels = (o) => o && o.options.map(x => `${x.n}. ${x.label}`);

console.log('\n── promptOptions on captured 2.1.311 screens');
const Q1 = read('askuserquestion-multi.txt');
const Q2 = read('askuserquestion-multi-q2.txt');
const SUBMIT = read('askuserquestion-submit.txt');
const SINGLE = read('askuserquestion-single.txt');
check('question 1 of a two-question widget: its four options',
  labels(promptOptions(Q1)), ['1. Red', '2. Blue', '3. Type something.', '4. Chat about this']);
check('question 2, after a digit answered question 1',
  labels(promptOptions(Q2)), ['1. Small', '2. Large', '3. Type something.', '4. Chat about this']);
check('the "Submit answers" screen is a widget with buttons too',
  labels(promptOptions(SUBMIT)), ['1. Submit answers', '2. Cancel']);
check('a single question', labels(promptOptions(SINGLE)), ['1. Cat', '2. Dog', '3. Type something.', '4. Chat about this']);
check('the 2.1.288 capture still parses', labels(promptOptions(read('askuserquestion.txt'))),
  ['1. Red', '2. Blue', '3. Type something.', '4. Chat about this']);
const keys = [Q1, Q2, SUBMIT, SINGLE].map(p => promptOptions(p).key);
check('each of the four screens has its own key', new Set(keys).size, 4);
// Down arrow on question 2 moved the caret to "2. Large" (seen live); nothing else changed.
const Q2_MOVED = Q2.replace('❯ 1. Small', '  1. Small').replace('  2. Large', '❯ 2. Large');
check('...and moving the caret does not make it a new question',
  promptOptions(Q2_MOVED).key, promptOptions(Q2).key);
// Two questions with the same options must still differ — question 2 of a "Yes/No" pair.
check('same options under a different question is a different key',
  promptOptions('Deploy now?\n❯ 1. Yes\n  2. No').key === promptOptions('Delete the branch?\n❯ 1. Yes\n  2. No').key, false);

// Review findings (Consilium, codex): a key built from a few lines of context and the
// labels alone let different questions collide — and a collision is a button that
// answers the wrong question. The key is the whole widget now.
const W = (q, d1, d2, l1 = 'Yes') => [q, `❯ 1. ${l1}`, `     ${d1}`, '  2. No', `     ${d2}`].join('\n');
check('same labels, different option descriptions: different keys',
  promptOptions(W('Pick', 'deploy to staging', 'abort')).key === promptOptions(W('Pick', 'deploy to PROD', 'abort')).key, false);
const LONG = 'x'.repeat(250);
check('labels that differ only past the 200-char display cut: different keys',
  promptOptions(W('Pick', 'd', 'd', LONG + 'A')).key === promptOptions(W('Pick', 'd', 'd', LONG + 'B')).key, false);
check('...while the button label itself is still cut for display',
  promptOptions(W('Pick', 'd', 'd', LONG)).options[0].label.length, 200);
const ctx = (first) => [first, ...Array.from({ length: 7 }, (_, i) => `line ${i}`), '❯ 1. Yes', '  2. No'].join('\n');
check('questions that differ eight lines above option 1: different keys',
  promptOptions(ctx('Delete the database?')).key === promptOptions(ctx('Delete the cache?')).key, false);
// Round 2 (codex): the LAST option's description is part of the question too.
const LAST = (d) => ['Pick a target', '❯ 1. Cancel', '  2. Deploy', `     ${d}`, '', 'Enter to select · Esc to cancel'].join('\n');
check('a different description under the last option: different keys',
  promptOptions(LAST('staging')).key === promptOptions(LAST('PRODUCTION')).key, false);
// ...but the footer under the widget is not: measured on 2.1.311, focusing "Type
// something." adds "ctrl+g to edit in Vim" to it while the same question waits.
const FOCUSED = SINGLE.replace('❯ 1. Cat', '  1. Cat').replace('  3. Type something.', '❯ 3. Type something.')
  .replace('Enter to select · ↑/↓ to navigate · Esc to cancel', 'Enter to select · ↑/↓ to navigate · ctrl+g to edit in Vim · Esc to cancel');
check('the footer changing under the same question keeps its key', promptOptions(FOCUSED).key, promptOptions(SINGLE).key);

// Review findings (agy): a FRAMED dialog carries its right border on every line.
const FRAMED = (pad) => ['⏺ I will update the file now.', '', '╭' + '─'.repeat(46 + pad) + '╮',
  '│ Do you want to make this edit to server.js?' + ' '.repeat(3 + pad) + '│',
  '│ ❯ 1. Yes' + ' '.repeat(37 + pad) + '│',
  "│   2. Yes, and don't ask again this session" + ' '.repeat(3 + pad) + '│',
  '╰' + '─'.repeat(46 + pad) + '╯'].join('\n');
check('a framed permission dialog: clean labels, no "│"',
  labels(promptOptions(FRAMED(0))), ['1. Yes', "2. Yes, and don't ask again this session"]);
check('...and its key does not change with the pane width', promptOptions(FRAMED(0)).key, promptOptions(FRAMED(20)).key);
check('...nor reach past the frame into the conversation above', /I will update/.test(promptOptions(FRAMED(0)).key), false);

console.log('\n── no buttons where a digit would be wrong');
check('the first-run trust screen (unnumbered) has none', promptOptions(read('firstrun-trust.txt')), null);
check('the Bypass Permissions warning (unnumbered) has none', promptOptions(read('firstrun-bypass.txt')), null);
check('an idle pane has none', promptOptions(read('firstrun-ready.txt')), null);
check('a numbered draft in the named chat\'s input box is not a widget',
  promptOptions(read('named-draft.txt'), { boxLabel: 'ccs-c-probe' }), null);
check('a numbered list without a caret is prose', promptOptions('Steps:\n  1. build\n  2. test'), null);
check('two carets is not one selected option', promptOptions('❯ 1. a\n❯ 2. b'), null);
check('a run that does not start at 1 is not a whole widget', promptOptions('❯ 2. a\n  3. b'), null);
check('one option is nothing to choose between', promptOptions('Continue?\n❯ 1. Yes'), null);
const TEN = ['Pick one', ...Array.from({ length: 10 }, (_, i) => `${i ? '  ' : '❯ '}${i + 1}. opt${i + 1}`)].join('\n');
check('ten options would need two digits: no buttons', promptOptions(TEN), null);
check('a numbered list in the answer above the widget is history, not options',
  labels(promptOptions(['⏺ Plan:', '  1. read', '  2. write', '  3. ship', '', 'Proceed?', '❯ 1. Yes', '  2. No'].join('\n'))),
  ['1. Yes', '2. No']);
check('every widget with buttons is one the detector announces',
  [Q1, Q2, SUBMIT, SINGLE].every(p => paneAwaitingInput(p)), true);

console.log('\n── the open-prompt store hands the server the current frame');
{
  const st = createEnginePromptStore();
  const F = { type: 'input_needed', sessionId: 's1', options: [{ n: 1, label: 'Yes' }], promptKey: 'k1' };
  st.track('s1', F);
  check('current() is the frame as sent (no replay tag)', st.current('s1', true), F);
  check('current() on a dead turn is null', st.current('s1', false), null);
  check('...and drops the entry', st.current('s1', true), null);
  st.track('s2', F);
  check('replay() still tags a replayed frame', st.replay('s2', true).replayed, true);
  // An answer consumes the prompt: no reload and no second window may redraw buttons
  // for it (agy: they would type a digit into the text field "Type something." opens).
  check('consume() with another key strips nothing', [st.consume('s2', 'k2'), st.current('s2', true).promptKey], [false, 'k1']);
  check('consume() with its key strips the buttons', st.consume('s2', 'k1'), true);
  const after = st.current('s2', true);
  check('...the banner stays, the options and key go', [after.type, after.options, after.promptKey], ['input_needed', undefined, undefined]);
  check('...so a reload replays no buttons', st.replay('s2', true).options, undefined);
  check('...and a second consume is a no-op', st.consume('s2', 'k1'), false);
  st.track('s2', { ...F, promptKey: 'k2' });
  check('the engine\'s next question is a new frame with its own key', st.current('s2', true).promptKey, 'k2');
  // Round 2 (codex): the engine sends input_resolved for a transient blip and then
  // announces the SAME question again. That must not bring its buttons back.
  const st2 = createEnginePromptStore();
  st2.track('s', F); st2.consume('s', 'k1'); st2.track('s', null);
  const again = st2.track('s', F);
  check('re-announced after a blip, an answered question comes back without buttons',
    [again.options, again.promptKey, st2.current('s', true).promptKey], [undefined, undefined, undefined]);
  check('...and track() returns that stripped frame for the engine to send', again.type, 'input_needed');
  check('a different question in the same turn keeps its buttons', st2.track('s', { ...F, promptKey: 'k9' }).promptKey, 'k9');
  st2.current('s', false);
  check('once the turn is seen dead, the session\'s answered keys are forgotten', st2.track('s', F).promptKey, 'k1');
  // Round 3 (codex): seen dead with NO open frame must forget them too — the ordinary
  // way a turn ends is input_resolved first, so there usually is no frame left.
  const st3 = createEnginePromptStore();
  st3.track('s', F); st3.consume('s', 'k1'); st3.track('s', null); st3.current('s', false);
  check('dead turn with no open frame: answered keys forgotten', st3.track('s', F).promptKey, 'k1');
  // And the engine says so itself when a turn ends, live session or not.
  const st4 = createEnginePromptStore();
  st4.track('s', F); st4.consume('s', 'k1'); st4.track('s', null);
  check('a mid-turn blip keeps them', st4.track('s', F).promptKey, undefined);
  st4.track('s', null, { turnEnded: true });
  check('the engine\'s turn-end edge forgets them: the next turn\'s identical question has buttons', st4.track('s', F).promptKey, 'k1');
}

console.log('\n── the server wiring');
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const at = src.indexOf("if (msg.type === 'engine_prompt_answer')");
  check('server.js handles engine_prompt_answer', at >= 0, true);
  const h = src.slice(at, src.indexOf("if (msg.type === 'subscribe_session')", at));
  const gate = h.indexOf('enginePrompts.current(sid, isSessionLive(sid))');
  const keyCmp = h.indexOf('open.promptKey !== msg.promptKey');
  const call = h.indexOf('answerEnginePrompt(');
  check('...checks the open prompt of a LIVE turn', gate >= 0, true);
  check('...compares the key the browser saw with the open prompt\'s', keyCmp > gate, true);
  check('...both BEFORE the pane is touched', call > keyCmp, true);
  check('...passes the SERVER\'s key, not the frame\'s', /const key = open\.promptKey;/.test(h) && /answerEnginePrompt\(sid, \{ key, choice: msg\.choice, onSent \}\)/.test(h), true);
  check('...consumes the prompt the moment a digit went in, and tells every window',
    /const onSent = \(\) => \{ if \(enginePrompts\.consume\(sid, key\)\) broadcastToSession\(sid, \{ type: 'engine_prompt_consumed'/.test(h), true);
  check('...and the reply names the question it is about', /reply\(\{ \.\.\.r, promptKey: key \}\)/.test(h), true);
  check('...one answer in flight per session', /_promptAnswering\.has\(sid\)/.test(h) && /finally \{ _promptAnswering\.delete\(sid\)/.test(h), true);
  const eng = fs.readFileSync(path.join(__dirname, '..', 'claude-interactive.js'), 'utf8');
  check('the engine attaches options + key to input_needed',
    /options: shape\.options, promptKey: shape\.key/.test(eng), true);
  check('the engine sends the frame the store KEPT (no buttons for an answered key)',
    /const kept = onPromptState\(/.test(eng) && /obj\.promptKey && kept && typeof kept === 'object' && !kept\.promptKey/.test(eng)
      && eng.indexOf('const kept = onPromptState(') < eng.indexOf('    wsSend(obj);\n    if (typeof fanout'), true);
  check('the engine\'s finally reports the turn END, separately from a prompt closing',
    /finally \{[\s\S]{0,600}onPromptState\(null, \{ turnEnded: true \}\)/.test(eng), true);
  check('every server call site forwards that edge to the store',
    (src.match(/onPromptState: \(f, m\) => enginePrompts\.track\([\w.]+, f, m\)/g) || []).length, 3);
  check('...and re-announces when the question changes in place',
    /key !== announcedKey && shapePolls >= AWAIT_CONFIRM_POLLS/.test(eng), true);
}

// ── layer 2 against a real pane ───────────────────────────────────────────────
if (spawnSync('tmux', ['-V']).status !== 0) {
  console.log('\nSKIP answerPrompt on a real pane: tmux not available');
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ccs-answer-'));
const made = [];
const tmux = (...a) => spawnSync('tmux', ['-L', TMUX_SOCKET, ...a], { encoding: 'utf8' });
function cleanup() {
  for (const n of made) tmux('kill-session', '-t', `=${n}`);
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch {}
}
process.on('exit', cleanup);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// A pane that draws `screen`, then records every byte it is sent. With `next`, it
// redraws `next` after the first byte — the way a real widget moves to question 2.
function fakePane(sid, screen, next) {
  const name = tmuxName(sid);
  const rec = path.join(DIR, sid + '.bytes');
  fs.writeFileSync(path.join(DIR, sid + '.a'), screen);
  if (next) fs.writeFileSync(path.join(DIR, sid + '.b'), next);
  const a = path.join(DIR, sid + '.a'), b = path.join(DIR, sid + '.b');
  const script = next
    ? `clear; cat '${a}'; stty raw -echo; dd bs=1 count=1 of='${rec}' 2>/dev/null; clear; cat '${b}'; exec cat >> '${rec}'`
    : `clear; cat '${a}'; stty raw -echo; exec cat > '${rec}'`;
  const r = tmux('new-session', '-d', '-s', name, '-x', '140', '-y', '50', 'sh', '-c', script);
  if (r.status !== 0) throw new Error('tmux new-session failed: ' + r.stderr);
  made.push(name);
  return () => { try { return fs.readFileSync(rec, 'utf8'); } catch { return ''; } };
}
async function settle() { await sleep(700); }

(async () => {
  const run = Date.now().toString(36);
  console.log('\n── answerPrompt on a real tmux pane');

  const s1 = `pa1${run}`, bytes1 = fakePane(s1, Q1);
  await settle();
  const k1 = promptOptions(Q1).key;
  check('a stale key sends nothing', [await answerPrompt(s1, { key: promptOptions(Q2).key, choice: 2 }), bytes1()], [{ ok: false, error: 'stale' }, '']);
  check('an option the widget does not have sends nothing', [await answerPrompt(s1, { key: k1, choice: 7 }), bytes1()], [{ ok: false, error: 'stale' }, '']);
  check('a choice that is not one digit is refused', [await answerPrompt(s1, { key: k1, choice: '2\r' }), bytes1()], [{ ok: false, error: 'invalid' }, '']);
  check('choice 0 is refused', (await answerPrompt(s1, { key: k1, choice: 0 })).error, 'invalid');
  let sentAt = null, staleSent = false;
  await answerPrompt(s1, { key: promptOptions(Q2).key, choice: 2, onSent: () => { staleSent = true; } });
  check('onSent never fires for an answer that sent nothing', staleSent, false);
  const t0 = Date.now();
  const r1 = await answerPrompt(s1, { key: k1, choice: 2, onSent: () => { sentAt = Date.now() - t0; } });
  check('onSent fires as soon as the digit is in, before the settle wait', sentAt !== null && sentAt < 300, true);
  await sleep(200);
  check('the current question with a real option: exactly that one digit reaches the pane', [r1.ok, bytes1()], [true, '2']);
  check('...and a pane that did not move on is reported as not advanced', r1.advanced, false);

  const s2 = `pa2${run}`, bytes2 = fakePane(s2, Q1, Q2);
  await settle();
  const r2 = await answerPrompt(s2, { key: k1, choice: 1 });
  check('a widget that moved on to question 2 is reported as advanced', [r2, bytes2()], [{ ok: true, advanced: true }, '1']);
  check('a second tap with question 1\'s key now sends nothing', [await answerPrompt(s2, { key: k1, choice: 1 }), bytes2()], [{ ok: false, error: 'stale' }, '1']);

  // tmux resolves a bare `-t ccs-x` by PREFIX. With only `ccs-<sid>zz` alive, an answer
  // for `<sid>` must find no pane — not type into its namesake.
  const s3 = `pa3${run}`, bytes3 = fakePane(s3 + 'zz', Q1);
  await settle();
  check('a pane whose name only starts with the session\'s is not answered',
    [await answerPrompt(s3, { key: k1, choice: 1 }), bytes3()], [{ ok: false, error: 'no_pane' }, '']);

  console.log(`\n${pass} passed, ${fail} failed`);
  cleanup();
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); cleanup(); process.exit(1); });
