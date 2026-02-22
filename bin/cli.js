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

// Ensure data and skills directories exist in APP_DIR
const dataDir = path.join(process.env.APP_DIR, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
const skillsDir = path.join(process.env.APP_DIR, 'skills');
if (!fs.existsSync(skillsDir)) fs.mkdirSync(skillsDir, { recursive: true });

// Seed config.json from bundled template on first run (config.json is gitignored)
const configDest = path.join(process.env.APP_DIR, 'config.json');
if (!fs.existsSync(configDest)) {
  const template = path.join(__dirname, '..', 'config.example.json');
  if (fs.existsSync(template)) fs.copyFileSync(template, configDest);
}

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
