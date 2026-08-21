// Verifies the terminal-session columns are added idempotently and defaults are sane.
// Run: node test/terminal-schema.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const openDatabase = require('../db-adapter');

let pass = 0, fail = 0;
function check(label, actual, expected) {
  try { assert.deepStrictEqual(actual, expected); pass++; console.log(`  ok   ${label}`); }
  catch { fail++; console.error(`  FAIL ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}

const dbPath = path.join(os.tmpdir(), `ccs-schema-test-${Date.now()}.db`);
const db = openDatabase(dbPath);
db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT)`);

// The exact statements server.js runs — copy any change here into server.js too.
const MIGRATIONS = [
  `ALTER TABLE sessions ADD COLUMN kind TEXT DEFAULT 'chat'`,
  `ALTER TABLE sessions ADD COLUMN terminal_agent TEXT`,
  `ALTER TABLE sessions ADD COLUMN agent_conv_id TEXT`,
];
function migrate() { for (const sql of MIGRATIONS) { try { db.exec(sql); } catch {} } }

migrate();
const cols = db.prepare(`SELECT * FROM pragma_table_info('sessions')`).all().map(r => r.name);
check('kind added', cols.includes('kind'), true);
check('terminal_agent added', cols.includes('terminal_agent'), true);
check('agent_conv_id added', cols.includes('agent_conv_id'), true);

migrate(); // second run must not throw and must not duplicate
const cols2 = db.prepare(`SELECT * FROM pragma_table_info('sessions')`).all().map(r => r.name);
check('migration is idempotent', cols2.length, cols.length);
// Positive control for the line above: an empty migrate() would satisfy it too.
// SQLite must actually reject the repeat, which is what the try/catch swallows.
let repeatRejected = false;
try { db.exec(MIGRATIONS[0]); } catch { repeatRejected = true; }
check('and the repeat was refused by SQLite, not skipped', repeatRejected, true);

db.prepare(`INSERT INTO sessions (id,title) VALUES (?,?)`).run('s1', 'legacy row');
check('existing rows default to chat', db.prepare(`SELECT kind FROM sessions WHERE id=?`).get('s1').kind, 'chat');

// The statements above only prove SQLite behaves — they say nothing about whether
// the server actually runs them. Assert the wiring too, so dropping a migration
// from server.js fails this suite instead of silently shipping a missing column.
const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
for (const sql of MIGRATIONS) {
  check(`server.js runs: ${sql.replace('ALTER TABLE sessions ADD COLUMN ', '')}`, serverSrc.includes(sql), true);
}

try { db.close(); } catch {}
for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(dbPath + suffix); } catch {} }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
