'use strict';
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const main = 'f98aa9a044616b1b965b889cf0c02a0d3b041f65';
const git = args => execFileSync('git', args, { encoding: 'utf8' });
const candidates = new Set([
  ...git(['diff', '--name-only', '-z', 'HEAD']).split('\0'),
  ...git(['ls-files', '--others', '--exclude-standard', '-z']).split('\0')
].filter(Boolean));
const forbidden = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\b(?:ghp_|github_pat_|sk_live_|rk_live_)[A-Za-z0-9_]{20,}/,
  /\bAIza[A-Za-z0-9_-]{30,}/,
  /["'](?:private_key|client_secret|payment_secret|api_secret)["']\s*:\s*["'][^"']{16,}["']/i
];
// Firebase browser API keys are public configuration already present in main.
// An unchanged historical public key is permitted; a newly authored one fails.
const baselineClient = git(['show', `${main}:index.html`]);
const allowedPublicKeys = new Set(baselineClient.match(/\bAIza[A-Za-z0-9_-]{30,}/g) || []);
const failures = [];
for (const file of candidates) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) continue;
  if (/(^|\/)\.env(?:\.|$)|(^|\/)\.dev\.vars(?:\.|$)|\.(?:pem|p12|key)$/.test(file)) {
    failures.push(`${file}: credential file`); continue;
  }
  const text = fs.readFileSync(file, 'utf8');
  text.split('\n').forEach((line, index) => {
    for (const pattern of forbidden) {
      const match = line.match(pattern);
      if (match && !allowedPublicKeys.has(match[0])) failures.push(`${file}:${index + 1}: credential pattern`);
    }
  });
}
if (git(['show', `${main}:wrangler.jsonc`]) !== fs.readFileSync('wrangler.jsonc', 'utf8')) {
  failures.push('wrangler.jsonc: production configuration changed');
}
if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
console.log(`PASS secret/config scan: ${candidates.size} changed files; no new credential patterns; production config unchanged`);
