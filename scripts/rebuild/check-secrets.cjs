'use strict';
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const main = 'f98aa9a044616b1b965b889cf0c02a0d3b041f65';
const productionConfigBaseline = '77f4fe6500e03cd3138563a577e1b681af2d7b03';
const git = args => execFileSync('git', args, { encoding: 'utf8' });
const candidates = new Set([
  // A clean commit still needs a complete rebuild scan, not an empty HEAD diff.
  ...git(['diff', '--name-only', '-z', main]).split('\0'),
  ...git(['ls-files', '-z', 'src', 'scripts/rebuild', 'tests/rebuild', 'docs/rebuild']).split('\0'),
  'worker.js', 'index.html', 'wrangler.jsonc', 'package.json',
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
let scanned = 0;
for (const file of candidates) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) continue;
  if (/(^|\/)\.env(?:\.|$)|(^|\/)\.dev\.vars(?:\.|$)|\.(?:pem|p12|key)$/.test(file)) {
    failures.push(`${file}: credential file`); continue;
  }
  const text = fs.readFileSync(file, 'utf8');
  scanned++;
  if (file === 'index.html' || file.startsWith('src/client/')) {
    // These bindings are privileged server capabilities. Browser configuration
    // may retain the existing public Firebase key but cannot contain these.
    if (/\b(?:PAYMENT_WEBHOOK_SECRET|SLIP2GO_API_SECRET|private_key|client_secret|payment_secret|api_secret|FIREBASE_ADMIN_PRIVATE_KEY)\b/i.test(text)) {
      failures.push(`${file}: privileged server capability in browser source`);
    }
  }
  text.split('\n').forEach((line, index) => {
    for (const pattern of forbidden) {
      const match = line.match(pattern);
      if (match && !allowedPublicKeys.has(match[0])) failures.push(`${file}:${index + 1}: credential pattern`);
    }
  });
}
if (git(['show', `${productionConfigBaseline}:wrangler.jsonc`]) !== fs.readFileSync('wrangler.jsonc', 'utf8')) {
  failures.push('wrangler.jsonc: production configuration changed');
}
if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
console.log(`PASS secret/config scan: ${scanned} rebuild/source files; no new credential patterns; no privileged browser bindings; production config matches reviewed disabled-payment baseline`);
