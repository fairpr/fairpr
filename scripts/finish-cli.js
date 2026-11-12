// Turns the ncc bundle into a single executable file: bin/proofpr.js
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, '.cli-build', 'index.js'), 'utf8');
fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
const out = path.join(root, 'bin', 'proofpr.js');
fs.writeFileSync(out, '#!/usr/bin/env node\n' + src.replace(/^#!.*\n/, ''));
fs.chmodSync(out, 0o755);
fs.rmSync(path.join(root, '.cli-build'), { recursive: true, force: true });
console.log('wrote bin/proofpr.js');
