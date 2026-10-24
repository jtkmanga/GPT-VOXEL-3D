'use strict';
const fs = require('node:fs');
const acorn = require('acorn');
const { execFileSync } = require('node:child_process');
const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
let count = 0;
for (const file of files) {
  if (/\.(?:js|cjs|mjs)$/.test(file)) {
    acorn.parse(fs.readFileSync(file, 'utf8'), { ecmaVersion: 'latest', sourceType: file.endsWith('.cjs') ? 'script' : 'module', allowHashBang: true });
    // Node wraps CommonJS files in a function with exports/require/module args.
    // Native --check also catches collisions with that wrapper's declarations.
    if (file.endsWith('.cjs')) execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    count++;
  } else if (file.endsWith('.html')) {
    const html = fs.readFileSync(file, 'utf8');
    for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
      if (/\bsrc\s*=/.test(match[1]) || /application\/(?:ld\+)?json/.test(match[1])) continue;
      acorn.parse(match[2], { ecmaVersion: 'latest', sourceType: /type\s*=\s*["']module["']/.test(match[1]) ? 'module' : 'script' });
      count++;
    }
  }
}
console.log(`PASS JavaScript syntax: ${count} files/inline scripts`);
