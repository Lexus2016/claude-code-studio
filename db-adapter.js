'use strict';

/**
 * Unified SQLite adapter.
 * - Node.js >= 22.5.0  →  built-in node:sqlite (DatabaseSync), no native compilation
 * - Node.js  < 22.5.0  →  better-sqlite3 (existing behaviour, unchanged)
 *
 * The returned db object exposes the same API surface used by server.js:
 *   db.exec(), db.prepare(), db.close()        — identical in both backends
 *   db.pragma(str)                              — shim on node:sqlite
 *   db.transaction(fn)  →  returns callable    — shim on node:sqlite
 */

function parseVersion(v) {
  return v.split('.').map(Number);
}

function nodeSatisfies(minStr) {
  const cur = parseVersion(process.versions.node);
  const min = parseVersion(minStr);
  for (let i = 0; i < min.length; i++) {
    if (cur[i] > min[i]) return true;
    if (cur[i] < min[i]) return false;
  }
  return true; // equal
}

const USE_BUILTIN = nodeSatisfies('22.13.0');
// ---------------------------------------------------------------------------
// node:sqlite shims
// ---------------------------------------------------------------------------

/**
 * Shim for better-sqlite3's db.pragma(str).
 *
 * Handles two cases:
 *  1. wal_checkpoint(…) — needs to read rows back, use prepare().all()
 *  2. Everything else   — fire-and-forget via exec()
 */
function pragmaShim(db, str) {
  const trimmed = str.trim();
  // Pragma that returns rows (wal_checkpoint is the only one used in this codebase)
  if (/^wal_checkpoint/i.test(trimmed)) {
    return db.prepare(`PRAGMA ${trimmed}`).all();
  }
  // Void pragmas — exec is sufficient
  db.exec(`PRAGMA ${trimmed}`);
  return undefined;
}

/**
 * Shim for better-sqlite3's db.transaction(fn).
 *
 * Returns a function that, when called:
 *  - begins an immediate transaction
 *  - calls fn(...args)
 *  - commits on success, rolls back on error
 *
 * Note: better-sqlite3 auto-upgrades nested transactions to savepoints.
 * No nested db.transaction() calls exist in this codebase so a simple
 * BEGIN/COMMIT/ROLLBACK is sufficient.
 */
function transactionShim(db, fn) {
  return function (...args) {
    db.exec('BEGIN');
    try {
      const result = fn(...args);
      db.exec('COMMIT');
      return result;
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch (_) { /* already rolled back */ }
      throw err;
    }
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Open a SQLite database at `dbPath` and apply the standard runtime pragmas.
 * Returns a db instance with a unified API regardless of which backend is used.
 *
 * @param {string} dbPath  Absolute path to the .db file.
 * @returns {object}       Database instance with .exec, .prepare, .pragma,
 *                         .transaction, and .close.
 */
module.exports = function openDatabase(dbPath) {
  let db;

  if (USE_BUILTIN) {
    const { DatabaseSync } = require('node:sqlite');
    db = new DatabaseSync(dbPath);

    // Add shims so callers don't need to know which backend is active
    db.pragma = (str) => pragmaShim(db, str);
    db.transaction = (fn) => transactionShim(db, fn);
  } else {
    let Database;
    try {
      Database = require('better-sqlite3');
    } catch {
      throw new Error(
        'Node.js < 22.5.0 requires better-sqlite3 to be compiled.\n' +
        'Either upgrade to Node.js 22.5+ or install build tools and run: npm install better-sqlite3'
      );
    }
    db = new Database(dbPath);
    // better-sqlite3 already has .pragma() and .transaction() natively
  }

  // Apply standard pragmas (same for both backends)
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');   // WAL durability guarantees make FULL unnecessary
  db.pragma('cache_size = -32000');    // 32 MB page cache
  db.pragma('temp_store = MEMORY');    // Temp tables in RAM
  db.pragma('foreign_keys = ON');      // Enforce FK constraints

  return db;
};
