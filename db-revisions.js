'use strict';

// Wall-clock timestamps are not change counters: two writes in the same second
// can leave MAX(updated_at) + COUNT(*) identical. Persist revisions in SQLite so
// every writer, transaction and restart observes the same invalidation boundary.
module.exports = function installRevisionTracking(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS ccs_data_revisions (
    name TEXT PRIMARY KEY,
    epoch TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 0
  )`);
  const statements = {};
  for (const table of ['tasks', 'task_chains']) {
    db.prepare('INSERT OR IGNORE INTO ccs_data_revisions (name, epoch) VALUES (?, lower(hex(randomblob(16))))').run(table);
    for (const event of ['INSERT', 'UPDATE', 'DELETE']) {
      db.exec(`CREATE TRIGGER IF NOT EXISTS ccs_revision_${table}_${event.toLowerCase()}
        AFTER ${event} ON ${table} BEGIN
          UPDATE ccs_data_revisions SET revision = revision + 1 WHERE name = '${table}';
        END`);
    }
    // Keep the ts/n response contract, but make ts an opaque revision, not a date.
    statements[table] = db.prepare(`SELECT epoch || ':' || revision AS ts,
      (SELECT COUNT(*) FROM ${table}) AS n FROM ccs_data_revisions WHERE name = '${table}'`);
  }
  return statements;
};
