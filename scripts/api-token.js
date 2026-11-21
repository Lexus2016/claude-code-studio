#!/usr/bin/env node
'use strict';
// ─── api-token: create / list / revoke external API tokens (issue #150) ──────
// The same token store the web UI manages over /api/api-tokens, reachable from a
// shell instead of a browser. That matters in Docker, where the client that needs
// the token (MCPHub, a laptop) has no session in the CCS web UI and the natural
// place to mint one is `docker exec`.
//
// Usage:
//   node scripts/api-token.js create --name mcphub --scope read
//   node scripts/api-token.js list
//   node scripts/api-token.js revoke <id>
//
// Prints the plaintext token exactly once, on create. It is not stored anywhere —
// only its SHA-256 is — so a lost token is revoked and replaced, never recovered.

const path = require('path');
const fs = require('fs');

// Same convention as bin/cli.js: a global/npx install keeps data in the directory
// the command is run from, unless APP_DIR already points somewhere.
if (!process.env.APP_DIR) process.env.APP_DIR = process.cwd();
const dataDir = path.join(process.env.APP_DIR, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const apiToken = require('../api-token.js');

function usage() {
  console.log(`usage:
  node scripts/api-token.js create --name <label> [--scope read|full]
  node scripts/api-token.js list
  node scripts/api-token.js revoke <id>

scope "read"  — list projects/tasks, read results (default)
scope "full"  — also create and cancel tasks; creating a task runs claude with the
               task description as its prompt, i.e. code execution in the container.`);
}

function flag(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const cmd = process.argv[2];

if (cmd === 'create') {
  const name = flag('name') || 'external client';
  const scope = flag('scope') || 'read';
  try {
    const { token, record } = apiToken.createToken({ name, scope });
    console.log(`\nToken created: ${record.name} (id: ${record.id}, scope: ${record.scope})\n`);
    console.log(`  ${token}\n`);
    console.log('This is the only time the token is shown — only its hash is stored.');
    console.log('Put it in the MCP client config as CCS_TOKEN, and set CCS_URL to this server.');
    console.log(`Revoke with: node scripts/api-token.js revoke ${record.id}\n`);
  } catch (e) {
    console.error(`error: ${e.message}`);
    process.exit(1);
  }
} else if (cmd === 'list') {
  const tokens = apiToken.listTokens();
  if (!tokens.length) {
    console.log('No external API tokens. The external API (/api/external/v1) refuses every request until one exists.');
  } else {
    for (const t of tokens) {
      console.log(`${t.id}  ${t.scope.padEnd(4)}  ${t.name}  created ${t.created_at}${t.last_used_at ? `, last used ${t.last_used_at}` : ', never used'}`);
    }
  }
} else if (cmd === 'revoke') {
  const id = process.argv[3];
  if (!id) { usage(); process.exit(1); }
  if (!apiToken.revokeToken(id)) { console.error(`error: no token with id ${id}`); process.exit(1); }
  console.log(`revoked ${id}`);
} else {
  usage();
  process.exit(cmd ? 1 : 0);
}
