#!/usr/bin/env node
'use strict';

const path = require('path');
const fs   = require('fs');
const os   = require('os');

// When launched via npx/global install, store user data in the current
// working directory (where the user runs the command), not inside the
// npm package directory.
if (!process.env.APP_DIR) {
  process.env.APP_DIR = process.cwd();
}

// Ensure the data directory exists in APP_DIR
const dataDir = path.join(process.env.APP_DIR, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

// Default workspace to APP_DIR/workspace (can be overridden by WORKDIR env)
if (!process.env.WORKDIR) {
  process.env.WORKDIR = path.join(process.env.APP_DIR, 'workspace');
}

const pkg = require('../package.json');
console.log(`\n🚀 Claude Code Chat v${pkg.version}`);
console.log(`   Data dir : ${process.env.APP_DIR}`);
console.log(`   Workspace: ${process.env.WORKDIR}`);
console.log(`   Port     : ${process.env.PORT || 3000}\n`);

require('../server.js');
