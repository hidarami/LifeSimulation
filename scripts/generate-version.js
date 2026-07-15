#!/usr/bin/env node
const { execSync } = require('child_process');
const { writeFileSync } = require('fs');
const { resolve } = require('path');

function run(cmd) {
  return execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
}

const repoRoot = resolve(__dirname, '..');
let version = '0.0.0';
let date = new Date().toISOString().split('T')[0];

try {
  version = run('git describe --tags --always --dirty');
} catch (error) {
  try {
    version = run('git rev-parse --short HEAD');
  } catch {}
}

const targetFile = resolve(repoRoot, 'sim', 'version.json');
const payload = {
  version,
  date,
};

writeFileSync(targetFile, JSON.stringify(payload, null, 2) + '\n', 'utf8');
console.log(`Generated version metadata at ${targetFile}`);
console.log(payload);
