'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const acorn = require('acorn');
// Active configuration is JSON-compatible JSONC at this checkpoint.
const config = JSON.parse(fs.readFileSync('wrangler.jsonc', 'utf8'));
assert.equal(config.main, 'worker.js');
assert.deepEqual(config.durable_objects.bindings, [
  { name: 'ROOM', class_name: 'GameRoom' },
  { name: 'ZONE', class_name: 'ZoneRoom' }
]);
assert.deepEqual(config.migrations.slice(0, 2), [
  { tag: 'v1', new_sqlite_classes: ['GameRoom'] },
  { tag: 'v2-zone-room', new_sqlite_classes: ['ZoneRoom'] }
]);
const ast = acorn.parse(fs.readFileSync(config.main, 'utf8'), { ecmaVersion: 'latest', sourceType: 'module' });
const exportedNames = ast.body.filter(n => n.type === 'ExportNamedDeclaration').map(n => n.declaration?.id?.name).filter(Boolean);
assert.ok(exportedNames.includes('GameRoom') && exportedNames.includes('ZoneRoom'));
assert.ok(ast.body.some(n => n.type === 'ExportDefaultDeclaration'));
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
assert.match(pkg.scripts['bundle:dry-run'], /--dry-run/);
assert.ok(!Object.keys(config.vars || {}).some(k => /SECRET|TOKEN|PRIVATE_KEY|PASSWORD/.test(k)));
console.log('PASS static checks: entrypoint, Durable Object exports/bindings, original migration tags, dry-run script, public vars');
