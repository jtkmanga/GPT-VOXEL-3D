'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const baseline = 'f98aa9a044616b1b965b889cf0c02a0d3b041f65';
const productionConfigBaseline = '77f4fe6500e03cd3138563a577e1b681af2d7b03';

function scanFixture(t, edit) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'voxel-p8-secret-scan-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, 'index.html'),
    execFileSync('git', ['show', `${baseline}:index.html`], { cwd: root }));
  fs.writeFileSync(path.join(directory, 'wrangler.jsonc'),
    execFileSync('git', ['show', `${productionConfigBaseline}:wrangler.jsonc`], { cwd: root }));
  edit?.(directory);
  return spawnSync(process.execPath, [path.join(root, 'scripts/rebuild/check-secrets.cjs')], {
    cwd: directory, encoding: 'utf8', env: { ...process.env,
      GIT_DIR: path.join(root, '.git'), GIT_WORK_TREE: directory }
  });
}

test('P8 full-tree secret scanner accepts preserved public Firebase configuration with no HEAD edits', t => {
  const result = scanFixture(t);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /rebuild\/source files/);
  assert.match(result.stdout, /production config matches reviewed disabled-payment baseline/);
});

test('P8 secret scanner rejects a privileged binding added to the browser even without a secret value', t => {
  const result = scanFixture(t, directory => fs.appendFileSync(path.join(directory, 'index.html'),
    '\n<script>const PAYMENT_WEBHOOK_SECRET = null;</script>\n'));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /privileged server capability in browser source/);
});

test('P8 secret scanner rejects newly authored credential patterns and never prints their values', t => {
  const marker = ['sk', 'live', 'SYNTHETIC'.repeat(4)].join('_');
  const result = scanFixture(t, directory => fs.appendFileSync(path.join(directory, 'index.html'),
    `\n<script>const accidentalKey = '${marker}';</script>\n`));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /credential pattern/);
  assert.equal(result.stderr.includes(marker), false);
});

test('P8 secret scanner rejects the legacy trusted slip-provider binding in browser source', t => {
  const result=scanFixture(t,directory=>fs.appendFileSync(path.join(directory,'index.html'),
    '\n<script>const SLIP2GO_API_SECRET = null;</script>\n'));
  assert.equal(result.status,1);
  assert.match(result.stderr,/privileged server capability in browser source/);
});

test('P8 secret scanner rejects untracked credential files before staging', t => {
  const result = scanFixture(t, directory => fs.writeFileSync(path.join(directory, 'synthetic-test.key'), 'not a real key'));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /synthetic-test\.key: credential file/);
});

test('P8 secret scanner rejects production configuration changes', t => {
  const result = scanFixture(t, directory => fs.appendFileSync(path.join(directory, 'wrangler.jsonc'), '\n// synthetic modification\n'));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /production configuration changed/);
});
