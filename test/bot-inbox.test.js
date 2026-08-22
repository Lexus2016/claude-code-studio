// The SQL half of the bot inbox. bots.test.js covers planInboxDelivery as pure logic;
// this covers the seam that logic depends on — the table, the index, and the column
// aliasing that hands SQL rows to that function in the shape it expects.
//
// Worth its own file because the seam is exactly where it can break silently: the query
// aliases from_bot AS "from", and planInboxDelivery reads `.from`. Rename one without the
// other and every letter reads as malformed, gets retired as junk, and the feature fails
// closed with no error anywhere.
// Run: node test/bot-inbox.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { planInboxDelivery, INBOX_TTL_MS } = require('../bots.js');

let pass = 0, fail = 0;
function check(label, actual, expected) {
  try { assert.deepStrictEqual(actual, expected); pass++; console.log(`  ok   ${label}`); }
  catch { fail++; console.error(`  FAIL ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccs-inbox-'));
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
const db = require('../db-adapter')(path.join(dir, 'test.db'));

// Copied verbatim from server.js. If the two drift, this test is the thing that says so.
db.exec(`
  CREATE TABLE IF NOT EXISTS bot_inbox (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id   TEXT NOT NULL,
    bot_id       TEXT NOT NULL,
    from_bot     TEXT NOT NULL,
    task         TEXT NOT NULL,
    created_at   INTEGER NOT NULL,
    delivered_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_bot_inbox_pending
    ON bot_inbox(session_id, bot_id) WHERE delivered_at IS NULL;
`);

const add = db.prepare('INSERT INTO bot_inbox (session_id,bot_id,from_bot,task,created_at) VALUES (?,?,?,?,?)');
const pending = db.prepare(`SELECT id, from_bot AS "from", task, created_at FROM bot_inbox
  WHERE session_id=? AND bot_id=? AND delivered_at IS NULL ORDER BY created_at ASC`);
const markDelivered = db.prepare('UPDATE bot_inbox SET delivered_at=? WHERE id=?');
const countPending = db.prepare(`SELECT COUNT(*) AS n FROM bot_inbox
  WHERE session_id=? AND bot_id=? AND delivered_at IS NULL`);

const NOW = Date.now();

console.log('inbox storage:');
{
  add.run('s1', 'writer', 'analyst', 'summarise the findings', NOW - 1000);
  add.run('s1', 'writer', 'critic', 'and check the numbers', NOW - 500);
  add.run('s1', 'other', 'analyst', 'not for writer', NOW);
  add.run('s2', 'writer', 'analyst', 'different conversation', NOW);

  const rows = pending.all('s1', 'writer');
  check('only this bot\'s letters come back', rows.length, 2);
  check('and only from this conversation', rows.every(r => r.task !== 'different conversation'), true);
  check('oldest first', rows[0].task, 'summarise the findings');

  // The seam: the alias must produce exactly the key the pure function reads.
  check('the sender arrives under the key planInboxDelivery reads', rows[0].from, 'analyst');
  const planned = planInboxDelivery({ letters: rows, now: NOW });
  check('so the rows survive planning instead of being retired as malformed',
    planned.deliver.map(d => d.from), ['analyst', 'critic']);
  check('and nothing is expired', planned.expired, []);
}

console.log('\ndelivery retires a letter:');
{
  const before = pending.all('s1', 'writer');
  markDelivered.run(NOW, before[0].id);
  const after = pending.all('s1', 'writer');
  check('a delivered letter stops coming back', after.length, before.length - 1);
  check('the row itself is kept for the audit trail',
    db.prepare('SELECT delivered_at FROM bot_inbox WHERE id=?').get(before[0].id).delivered_at, NOW);
}

console.log('\npending count bounds the queue:');
{
  check('it counts only undelivered letters for this pair', countPending.get('s1', 'writer').n, 1);
  check('an empty pair counts zero', countPending.get('s1', 'nobody').n, 0);
}

console.log('\nan expired letter is retired, not delivered:');
{
  add.run('s3', 'writer', 'analyst', 'stale', NOW - INBOX_TTL_MS - 1000);
  const rows = pending.all('s3', 'writer');
  const planned = planInboxDelivery({ letters: rows, now: NOW });
  check('planning refuses it', planned.deliver, []);
  check('and names it for retirement', planned.expired, [rows[0].id]);
  // The caller must retire expired letters too, or they are re-read on every run forever.
  for (const id of planned.expired) markDelivered.run(NOW, id);
  check('after which it stops coming back', pending.all('s3', 'writer').length, 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
