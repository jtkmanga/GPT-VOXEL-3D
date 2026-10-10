'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const acorn = require('acorn');
const { moduleGraph, workerSourceView, walk, ROOT } = require('../../scripts/rebuild/source-view.cjs');
const { buildClient } = require('../../scripts/rebuild/build-client.cjs');
const { createHarness } = require('./harness.cjs');
const { wireInventory } = require('./wire-inventory.cjs');

const P0 = '0acbdf43a94c9c228e07957cf2828c1c99a6e83a';
function baseline(file) { return execFileSync('git', ['show', `${P0}:${file}`], { encoding: 'utf8' }); }
function parse(source, sourceType = 'script') { return acorn.parse(source, { ecmaVersion: 'latest', sourceType }); }
function inline(html) { return [...html.matchAll(/<script>([\s\S]*?)<\/script>/gi)].at(-1)[1]; }
function plain(value) { return JSON.parse(JSON.stringify(value)); }

// Fold only side-effect-free literal expressions. No identifiers, calls, getters,
// clocks or random values are evaluated by the equivalence proof.
function constant(node, bindings = {}) {
  if (node?.type === 'Identifier' && Object.hasOwn(bindings, node.name)) return { value: bindings[node.name] };
  if (node?.type === 'Literal' && !node.regex && !node.bigint) return { value: node.value };
  if (node?.type === 'ArrayExpression') {
    const entries = node.elements.map(n => constant(n, bindings));
    if (entries.every(Boolean)) return { value: entries.map(e => e.value) };
  }
  if (node?.type === 'ObjectExpression') {
    const object = {};
    for (const p of node.properties) {
      if (p.type !== 'Property' || p.kind !== 'init' || p.method || p.computed || p.shorthand) return null;
      const result = constant(p.value, bindings);
      if (!result) return null;
      const key = p.key.name ?? p.key.value;
      if (key === '__proto__') return null;
      object[key] = result.value;
    }
    return { value: object };
  }
  if (node?.type === 'BinaryExpression') {
    const left = constant(node.left, bindings), right = constant(node.right, bindings);
    if (!left || !right || typeof left.value !== 'number' || typeof right.value !== 'number') return null;
    const operations = { '+': (a,b) => a+b, '-': (a,b) => a-b, '*': (a,b) => a*b, '/': (a,b) => a/b };
    if (operations[node.operator]) return { value: operations[node.operator](left.value, right.value) };
  }
  return null;
}
function normalized(node) {
  if (!node || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map(normalized);
  const value = constant(node);
  if (value) return { constant: value.value };
  return Object.fromEntries(Object.entries(node).filter(([key]) => !['start', 'end', 'raw'].includes(key))
    .map(([key, value]) => [key, normalized(value)]));
}
function normalizedClient(source) {
  const ast = parse(source), bindings = {};
  // Only earlier immutable primitive top-level constants can fold a later const
  // initializer (e.g. MAP_SIZE / SECURE_ZONE_GRID_SIZE). Never rewrite a function
  // body or evaluate mutable object aliases, calls or shadowed parameters.
  for (const node of ast.body) {
    if (node.type !== 'VariableDeclaration' || node.kind !== 'const') continue;
    for (const declaration of node.declarations) {
      if (declaration.id.type !== 'Identifier') continue;
      const result = constant(declaration.init, bindings);
      if (!result || !['number', 'string', 'boolean'].includes(typeof result.value)) continue;
      bindings[declaration.id.name] = result.value;
      declaration.init = { type: 'Literal', value: result.value };
    }
  }
  return normalized(ast);
}
function declarations(ast) {
  const output = new Map();
  for (let node of ast.body) {
    if (node.type === 'ExportNamedDeclaration') node = node.declaration;
    if (!node) continue;
    if (node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') output.set(node.id.name, node);
    if (node.type === 'VariableDeclaration') for (const declaration of node.declarations) {
      if (declaration.id.type === 'Identifier') output.set(declaration.id.name, declaration.init);
    }
  }
  return output;
}

test('P1 generated client is current and uses the real imported shared manifest', async () => {
  assert.equal(await buildClient(), fs.readFileSync('index.html', 'utf8'));
  const entry = await import(pathToFileURL(path.join(ROOT, 'src/client/entry.mjs')));
  assert.equal(entry.CLIENT_SOURCES.length, 12);
  for (const name of ['config', 'protocol', 'catalog']) {
    assert.equal(entry[name], await import(pathToFileURL(path.join(ROOT, `src/shared/${name}.mjs`))));
  }
  const fragments = entry.CLIENT_SOURCES.map(f => fs.readFileSync(path.join(ROOT, 'src/client', f), 'utf8')).join('');
  assert.match(fragments, /config\.SERVER_MAP_SIZE/);
  assert.match(fragments, /protocol\.WS_MESSAGE\.AUTH/);
  assert.match(fragments, /catalog\.WHEEL_ITEMS/);
  assert.match(fragments, /catalog\.CLIENT_PAYMENT_ITEMS/);
});

test('P1 client entire ordered executable AST and external HTML match pinned P0', () => {
  const old = baseline('index.html'), current = fs.readFileSync('index.html', 'utf8');
  assert.deepEqual(normalizedClient(inline(current)), normalizedClient(inline(old)));
  assert.equal(current.replace(inline(current), '<SCRIPT>'), old.replace(inline(old), '<SCRIPT>'));
});

test('P1 every original Worker declaration and HTTP router match pinned P0', () => {
  const old = parse(baseline('worker.js'), 'module');
  const current = declarations(parse(workerSourceView()));
  const names = [];
  for (const [name, node] of declarations(old)) {
    assert.ok(current.has(name), `Original declaration retained: ${name}`);
    assert.deepEqual(normalized(current.get(name)), normalized(node), `P0 semantic AST: ${name}`);
    names.push(name);
  }
  assert.ok(names.includes('GameRoom') && names.includes('ZoneRoom') && names.includes('secureLuckyReward'));
  assert.deepEqual(normalized(current.get('worker')), normalized(old.body.find(n => n.type === 'ExportDefaultDeclaration').declaration));
});

test('P1 single authored source of truth and complete unchanged wire vocabulary', async () => {
  const config = await import(pathToFileURL(path.join(ROOT, 'src/shared/config.mjs')));
  const protocol = await import(pathToFileURL(path.join(ROOT, 'src/shared/protocol.mjs')));
  const catalog = await import(pathToFileURL(path.join(ROOT, 'src/shared/catalog.mjs')));
  const graph = moduleGraph();
  for (const key of Object.keys(config)) {
    const declarationsFound = graph.flatMap(m => [...declarations(m.ast).keys()].filter(name => name === key));
    assert.equal(declarationsFound.length, 1, `One declaration of ${key}`);
  }
  const vocabulary = new Set(Object.values(protocol.WS_MESSAGE));
  assert.equal(vocabulary.size, 28);
  for (const name of ['WS_MESSAGE', 'PROTOCOL_VERSION']) {
    const owners = graph.filter(m => declarations(m.ast).has(name));
    assert.equal(owners.length, 1, `One authored declaration of ${name}`);
    assert.equal(path.relative(ROOT, owners[0].file), 'src/shared/protocol.mjs');
  }
  const oldReferences = [
    ...wireInventory(baseline('worker.js'), { sourceType: 'module' }),
    ...wireInventory(inline(baseline('index.html')))
  ];
  const oldTypes = new Set(oldReferences.map(r => r.value));
  assert.equal(oldTypes.size, 28, 'Pinned P0 has exactly 28 actual wire types');
  assert.equal(oldReferences.filter(r => r.role === 'send').length, 67, 'All P0 authored packet definitions inventoried');
  assert.equal(oldReferences.filter(r => r.role === 'dispatch').length, 36, 'All P0 authored packet dispatches inventoried');
  assert.deepEqual([...vocabulary].sort(), [...oldTypes].sort());
  const entry = await import(pathToFileURL(path.join(ROOT, 'src/client/entry.mjs')));
  const client = entry.CLIENT_SOURCES.map(f => fs.readFileSync(path.join(ROOT, 'src/client', f), 'utf8')).join('');
  for (const name of ['WS_MESSAGE', 'PROTOCOL_VERSION']) {
    assert.ok(!declarations(parse(client)).has(name), `No duplicated client ${name}`);
  }
  const authored = [
    ...graph.filter(m => m.file.includes('/src/worker/')).flatMap(m =>
      wireInventory(m.source, { sourceType: 'module', messages: protocol.WS_MESSAGE })),
    ...wireInventory(client, { messages: protocol.WS_MESSAGE })
  ];
  assert.ok(authored.every(r => r.key && protocol.WS_MESSAGE[r.key] === r.value),
    'Every client/Worker authored wire send and dispatch must reference shared WS_MESSAGE');
  const histogram = references => Object.fromEntries([...vocabulary].sort().map(type =>
    [type, references.filter(r => r.value === type).length]));
  assert.deepEqual(histogram(authored), histogram(oldReferences), 'Preserve every authored P0 send/dispatch occurrence');
  console.log(`PASS wire inventory: ${oldTypes.size} P0/P1 types, ${authored.length} matching shared references; UI null and HTTP eq excluded`);
  for (const module of graph.filter(m => m.file.includes('/src/worker/'))) {
    walk(module.ast, node => {
      if (node.type === 'Property' && (node.key.name ?? node.key.value) === 'type' && node.value.type === 'Literal') {
        assert.ok(!vocabulary.has(node.value.value), `Worker wire type must import vocabulary: ${module.file}`);
      }
    });
  }
  assert.deepEqual(catalog.PAYMENT_PRICES, { speed: 10, coin: 20, vip1: 50 });
  assert.equal(Object.getPrototypeOf(catalog.PAYMENT_CONFIG), Object.prototype);
  assert.deepEqual(Object.keys(catalog.PAYMENT_CONFIG.vip1), ['price', 'column', 'duration']);
  assert.deepEqual(Object.keys(catalog.WHEEL_ITEMS[0]), ['label', 'value', 'weight', 'color']);
});

test('P1 wire inventory separates state and HTTP options from real packet discriminators', () => {
  const source = `
    const state = { pendingPayment: { type: null }, decoration: { type: 'not_a_message' } };
    const payload = { checkAmount: { type: 'eq', amount: '50' } };
    fetch('/verify-slip', { body: JSON.stringify(payload) });
    const packet = { type: 'auth', token: 'synthetic' };
    ws.send(JSON.stringify(packet));
    this.send(ws, { type: 'welcome' });
    if (m?.type === 'move') dispatch();
    switch (message.type) { case 'handoff_resumed': break; }
  `;
  assert.deepEqual(wireInventory(source).map(r => r.value).sort(), ['auth', 'handoff_resumed', 'move', 'welcome']);
  assert.throws(() => wireInventory('ws.send(JSON.stringify({ type: null }));'), /Invalid authored wire discriminator/);
  assert.throws(() => wireInventory("ws.send(JSON.stringify({ type: '' }));"), /Invalid authored wire discriminator/);
});

test('P1 actual native Worker entrypoint exports and module imports load', async () => {
  const worker = await import(pathToFileURL(path.join(ROOT, 'worker.js')));
  assert.deepEqual(Object.keys(worker).sort(), ['GameRoom', 'ZoneRoom', 'default', 'verifyFirebaseIdToken'].sort());
  assert.equal(worker.GameRoom.name, 'GameRoom');
  assert.equal(worker.ZoneRoom.name, 'ZoneRoom');
  const response = await worker.default.fetch(new Request('https://rebuild.invalid/health'), {});
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'VOXEL RUN v4 online');
  for (const module of moduleGraph()) await import(pathToFileURL(module.file));
});

test('P1 Durable Object bindings, migrations and production config unchanged byte-for-byte', () => {
  assert.equal(fs.readFileSync('wrangler.jsonc', 'utf8'), baseline('wrangler.jsonc'));
  const config = JSON.parse(baseline('wrangler.jsonc'));
  assert.equal(config.main, 'worker.js');
  assert.deepEqual(config.durable_objects.bindings.map(b => b.class_name), ['GameRoom', 'ZoneRoom']);
  assert.deepEqual(config.migrations.map(m => m.tag), ['v1', 'v2-zone-room']);
});

test('P1 actual bundle and pinned P0 agree on startup, players, movement and economy', async t => {
  fs.mkdirSync('work', { recursive: true });
  const oldFile = path.resolve('work/pinned-p0-worker.js');
  fs.writeFileSync(oldFile, baseline('worker.js'));
  const old = createHarness({ workerPath: oldFile }), current = createHarness();
  t.after(async () => { await old.close(); await current.close(); });
  async function scenario(h) {
    const one = await h.connect({ uid: 'p1-differential-one', name: 'Same Name' });
    const two = await h.connect({ uid: 'p1-differential-two', name: 'Other' });
    await one.send({ type: 'move', x: 1, y: 0, z: 0, r: 0.5 });
    await h.advance(200);
    const coin = one.messages('welcome')[0].coins[0];
    h.place(one, { x: coin.x, z: coin.z, y: 0 });
    await one.send({ type: 'collect', id: coin.id });
    await one.send({ type: 'collect', id: coin.id });
    await h.advance(60_000);
    const entitlement = await h.request('/entitlements', { headers: { Authorization: 'Bearer ' + h.token('p1-differential-one') } });
    return plain({ one: one.messages(), two: two.messages(), entitlements: await entitlement.json(), routes: h.records.routes });
  }
  assert.deepEqual(await scenario(current), await scenario(old));
});
