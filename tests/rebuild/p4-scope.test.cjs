'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const acorn = require('acorn');
const { ROOT, moduleGraph, walk } = require('../../scripts/rebuild/source-view.cjs');
const { buildClient, classicMovementKernel } = require('../../scripts/rebuild/build-client.cjs');

// This is an active P4 comparison to the real, pushed P3 rebuild checkpoint.
// All runtime/security regressions still execute against the active source.
const P3 = '592c0707a746f7a55002ce5fcc7110f00cdccf66';
const oldSources = new Map();
function baseline(file) {
  if (!oldSources.has(file)) oldSources.set(file,
    execFileSync('git', ['show', `${P3}:${file}`], { cwd: ROOT, encoding: 'utf8' }));
  return oldSources.get(file);
}
const current = file => fs.readFileSync(path.join(ROOT, file), 'utf8');
const parse = (source, sourceType = 'script') => acorn.parse(source, { ecmaVersion: 'latest', sourceType });
function clean(value) {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(clean);
  return Object.fromEntries(Object.entries(value).filter(([key]) => !['start', 'end', 'raw'].includes(key))
    .map(([key, child]) => [key, clean(child)]));
}
const same = (a, b) => JSON.stringify(clean(a)) === JSON.stringify(clean(b));
const statement = source => parse(`async function proofContext() { ${source} }`).body[0].body.body[0];
function remove(body, source, description) {
  const expected = statement(source);
  assert.equal(body.filter(node => same(node, expected)).length, 1, description);
  return body.filter(node => !same(node, expected));
}
function methods(source) {
  const declaration = parse(source, 'module').body.find(node => node.declaration?.type === 'ClassDeclaration').declaration;
  return new Map(declaration.body.body.map(node => [node.key.name, node]));
}
function units(source, sourceType = 'script') {
  return parse(source, sourceType).body.flatMap(node => {
    node = node.declaration || node;
    return node.type === 'VariableDeclaration'
      ? node.declarations.map(item => ({ ...node, declarations: [item] })) : [node];
  });
}
function name(node) {
  if (node.type === 'FunctionDeclaration') return `function:${node.id.name}`;
  if (node.type === 'VariableDeclaration') return `variable:${node.declarations[0].id.name}`;
  if (node.type === 'ExpressionStatement' && node.expression.type === 'AssignmentExpression' &&
      node.expression.left.type === 'Identifier') return `assignment:${node.expression.left.name}`;
  if (node.type === 'ImportDeclaration') return `import:${node.source.value}`;
  return null;
}
function preserveClient(file, changed = [], added = []) {
  const before = units(baseline(file)), after = units(current(file));
  const originalNames = new Set(before.map(name).filter(Boolean));
  const addedNames = after.map(name).filter(key => key && !originalNames.has(key));
  assert.deepEqual(addedNames.sort(), [...added].sort(), `${file}: exact new economy declarations`);
  const reviewed = new Set(changed);
  for (const key of reviewed) assert.ok(originalNames.has(key), `${file}: original reviewed economy boundary ${key}`);
  const bounded = body => body.filter(node => !addedNames.includes(name(node)))
    .map(node => reviewed.has(name(node)) ? { reviewedEconomyBoundary: name(node) } : clean(node));
  assert.deepEqual(bounded(after), bounded(before), `${file}: every other ordered executable statement is preserved`);
}
function internalRoute(node) {
  if (node.type !== 'IfStatement') return null;
  const paths = [];
  walk(node.test, item => {
    if (item.type === 'Literal' && typeof item.value === 'string' && item.value.startsWith('/_internal/')) paths.push(item.value);
  });
  return paths[0] || null;
}

test('P4 retains exact Firebase/auth/session/schema/movement/public configuration and payment sources', () => {
  for (const file of ['worker.js', 'wrangler.jsonc', 'src/shared/config.mjs', 'src/shared/protocol.mjs',
    'src/shared/catalog.mjs', 'src/shared/movement.mjs', 'src/worker/http.mjs', 'src/worker/router.mjs',
    'src/worker/firebase-auth.mjs', 'src/worker/sessions.mjs', 'src/worker/security.mjs',
    'src/worker/spatial.mjs', 'src/worker/movement.mjs']) {
    assert.equal(current(file), baseline(file), file);
  }
});

test('P4 dispatch retains every auth/ownership/rate/sequence guard while retrying failed economic persistence', () => {
  const file = 'src/worker/room-security.mjs';
  const before = parse(baseline(file), 'module'), after = parse(current(file), 'module');
  const fn = after.body.find(node => node.type === 'FunctionDeclaration' && node.id.name === 'handleFrame');
  assert.ok(fn);
  fn.body.body = remove(fn.body.body,
    'const economyAction = [WS_MESSAGE.COLLECT, WS_MESSAGE.COLLECT_BOX, WS_MESSAGE.SPIN_BOX].includes(packet.type);',
    'Only the three canonical economy request kinds defer recent-request caching');
  fn.body.body = remove(fn.body.body, 'let requestKey;', 'One pending economy request key');
  const request = fn.body.body.find(node => node.type === 'IfStatement' &&
    same(node.test, statement('if (packet.requestId !== undefined) {}').test));
  assert.ok(request, 'Original request-ID replay guard retained');
  request.consequent.body = remove(request.consequent.body, 'requestKey = key;', 'Exactly one captured validated request ID');
  const deferred = statement('if (!economyAction) { player.recentRequests.push(key); if (player.recentRequests.length > 128) player.recentRequests.shift(); }');
  const index = request.consequent.body.findIndex(node => same(node, deferred));
  assert.notEqual(index, -1, 'Non-economic replay bookkeeping remains the exact original bounded sequence');
  request.consequent.body.splice(index, 1, ...deferred.consequent.body);
  const completed = statement('const completed = await dispatch(packet, player);');
  const dispatchIndex = fn.body.body.findIndex(node => same(node, completed));
  assert.notEqual(dispatchIndex, -1, 'Only the actual runtime dispatch result determines whether an economy action completed');
  fn.body.body.splice(dispatchIndex, 1, statement('await dispatch(packet, player);'));
  fn.body.body = remove(fn.body.body,
    'if (economyAction && completed === true && requestKey && player) { player.recentRequests ||= []; player.recentRequests.push(requestKey); if (player.recentRequests.length > 128) player.recentRequests.shift(); }',
    'Only successful economy dispatches are added to the bounded same-socket replay cache');
  assert.deepEqual(clean(after), clean(before), 'All other auth, deadline, ownership, packet queue, rates, sequence and checkpoint statements remain exact');
});

test('P4 preserves all Worker auth, movement, ownership, handoff and payment methods', () => {
  const reviewed = {
    'src/worker/game-room.mjs': ['constructor', 'fetch', 'coinSnapshot', 'boxSnapshot', 'handleCollect', 'handleCollectBox', 'handleSpinBox'],
    'src/worker/zone-room.mjs': ['handleCollect', 'handleCollectBox', 'handleSpinBox']
  };
  for (const [file, changed] of Object.entries(reviewed)) {
    const before = methods(baseline(file)), after = methods(current(file));
    const added = file.endsWith('game-room.mjs')
      ? ['economyPlayers', 'scheduleEconomyAlarm', 'alarm', 'economyPosition', 'publishCoin', 'publishBox'] : ['checkpointEconomy'];
    assert.deepEqual([...after.keys()].filter(key => !before.has(key)), added, `${file}: exact new economy methods`);
    assert.deepEqual([...after.keys()].filter(key => !added.includes(key)), [...before.keys()], `${file}: no original method removed or reordered`);
    for (const key of changed) assert.ok(before.has(key), `${file}: original reviewed economy method ${key}`);
    for (const [key, original] of before) if (!changed.includes(key))
      assert.deepEqual(clean(after.get(key)), clean(original), `${file}: preserved ${key}`);
  }
});

test('P4 retains original packet forwarding for economic identity, auth, movement and cancellation', () => {
  for (const [file, methodName] of [['src/worker/game-room.mjs', 'webSocketMessage'], ['src/worker/zone-room.mjs', 'dispatchMessage']]) {
    const before = methods(baseline(file)).get(methodName), after = methods(current(file)).get(methodName);
    let forwarded = 0;
    walk(after, node => {
      if (node.type !== 'CallExpression' || node.callee.type !== 'MemberExpression' ||
          node.callee.object.type !== 'ThisExpression' ||
          !['handleCollectBox', 'handleSpinBox'].includes(node.callee.property.name)) return;
      assert.deepEqual(node.arguments.map(argument => argument.name), ['ws', 'p', 'm'],
        'The actual parsed packet is forwarded only to existing economic handlers');
      forwarded++;
    });
    assert.equal(forwarded, 2, `${file}: both existing box handlers receive the action request identity`);
    assert.deepEqual(clean(after), clean(before), `${file}: every other dispatch statement and argument remains exact`);
  }
});

test('P4 constructor adds only the logical economy store and durable economic alarm schedule', () => {
  const file = 'src/worker/game-room.mjs';
  const before = methods(baseline(file)).get('constructor'), after = methods(current(file)).get('constructor');
  after.value.body.body = remove(after.value.body.body,
    'this.economy = new EconomyStore(ctx, now => this.economyPlayers(now));',
    'Exactly one economy store is created by GameRoom using authoritative server players');
  let ready = 0;
  walk(after, node => {
    if (node.type !== 'AssignmentExpression' || node.left.type !== 'MemberExpression' ||
        node.left.object.type !== 'ThisExpression' || node.left.property.name !== 'ready') return;
    const callback = node.right.arguments[0];
    assert.equal(callback.type, 'ArrowFunctionExpression');
    callback.body.body = remove(callback.body.body, 'await this.scheduleEconomyAlarm();',
      'Startup re-arms the persisted economic cooldown alarm once');
    ready++;
  });
  assert.equal(ready, 1);
  assert.deepEqual(clean(after), clean(before), 'All original schemas, session/handoff/payment setup, legacy cooldown migration and auth deadlines remain exact');
});

test('P4 loads one economy module only from GameRoom and delegates both canonical snapshots', () => {
  const beforeFiles = execFileSync('git', ['ls-tree', '-r', '--name-only', P3, 'src/worker'],
    { cwd: ROOT, encoding: 'utf8' }).trim().split('\n');
  const graph = moduleGraph();
  const activeFiles = graph.map(module => path.relative(ROOT, module.file));
  for (const file of beforeFiles) assert.ok(activeFiles.includes(file), `Existing Worker module remains active: ${file}`);
  assert.deepEqual(activeFiles.filter(file => file.startsWith('src/worker/') && !beforeFiles.includes(file)), ['src/worker/economy.mjs']);
  const game = parse(current('src/worker/game-room.mjs'), 'module');
  const zone = parse(current('src/worker/zone-room.mjs'), 'module');
  const imports = ast => ast.body.filter(node => node.type === 'ImportDeclaration' && node.source.value === './economy.mjs');
  assert.equal(imports(game).length, 1);
  assert.deepEqual(imports(game)[0].specifiers.map(node => [node.imported.name, node.local.name]), [['EconomyStore', 'EconomyStore']]);
  assert.equal(imports(zone).length, 0, 'A movement zone cannot instantiate an independent economic resource pool');
  const active = methods(current('src/worker/game-room.mjs'));
  const canonical = methods('export class GameRoom { coinSnapshot() { return this.economy.coinSnapshot(); } boxSnapshot(now=Date.now()) { return this.economy.boxSnapshot(now); } }');
  for (const key of ['coinSnapshot', 'boxSnapshot']) assert.deepEqual(clean(active.get(key)), clean(canonical.get(key)),
    `GameRoom delegates ${key} to the single economic store`);
  const economy = graph.find(module => module.file === path.join(ROOT, 'src/worker/economy.mjs'));
  assert.ok(economy);
  walk(economy.ast, node => {
    if (node.type !== 'CallExpression' || node.callee.type !== 'MemberExpression' || node.callee.property.name !== 'exec') return;
    const sql = node.arguments[0];
    const source = sql?.type === 'Literal' ? sql.value : sql?.type === 'TemplateLiteral'
      ? sql.quasis.map(part => part.value.cooked).join('') : '';
    assert.doesNotMatch(source,
      /\b(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM|ALTER\s+TABLE|CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?)\s+voxel_(?:sessions|zone_handoffs|handoff_grants|payments|entitlements)\b/i,
      'Economic persistence cannot mutate session, handoff, payment or entitlement authority');
  });
});

test('P4 internal session, entitlement, payment, handoff and WebSocket upgrade routes are exact', () => {
  const file = 'src/worker/game-room.mjs';
  const before = methods(baseline(file)).get('fetch').value.body.body;
  const after = methods(current(file)).get('fetch').value.body.body;
  const reviewed = new Set(['/_internal/zone-collect', '/_internal/zone-collect-box', '/_internal/zone-spin-box']);
  const oldRoutes = before.map(internalRoute).filter(Boolean), activeRoutes = after.map(internalRoute).filter(Boolean);
  assert.deepEqual(activeRoutes, oldRoutes, 'All original internal paths are retained in order');
  const bounded = body => body.map(node => reviewed.has(internalRoute(node))
    ? { reviewedEconomyRoute: internalRoute(node) } : clean(node));
  assert.deepEqual(bounded(after), bounded(before), 'Every statement outside the three reviewed economy routes remains exact');
});

test('P4 keeps non-economy browser fragments and every movement/auth/handoff declaration exact', () => {
  for (const file of ['auth-state.js', 'audio.js', 'firebase-multiplayer.js', 'menu-shop.js', 'world.js', 'controls.js',
    'secure-entitlements-payment.js', 'secure-wheel-startup.js']) {
    assert.deepEqual(clean(parse(current(`src/client/${file}`))), clean(parse(baseline(`src/client/${file}`))), file);
  }
  preserveClient('src/client/secure-menu-economy.js', ['assignment:collectCoin', 'function:secureApplyLuckyBoxState',
    'function:secureUpdateLuckyBoxTimer', 'function:secureRequestLuckyBoxCollect', 'assignment:spinWheel', 'assignment:spawnLuckyBoxes'],
  ['function:secureEconomyRequestId', 'variable:secureEconomyRequestCounter']);
  preserveClient('src/client/secure-snapshots.js', ['function:secureApplyCoinSnapshot', 'function:secureUpdateCoinState']);
  preserveClient('src/client/secure-socket-handoff.js', ['function:secureHandleSocketMessage']);
});

test('P4 socket changes stay within existing economy packet cases', () => {
  const cases = source => {
    const fn = parse(source).body.find(node => node.type === 'FunctionDeclaration' && node.id.name === 'secureHandleSocketMessage');
    return new Map(fn.body.body.find(node => node.type === 'SwitchStatement').cases
      .map(node => [node.test?.property.name, node]));
  };
  const before = cases(baseline('src/client/secure-socket-handoff.js'));
  const after = cases(current('src/client/secure-socket-handoff.js'));
  assert.deepEqual([...after.keys()], [...before.keys()], 'No protocol handler is added, removed or reordered');
  const reviewed = new Set(['SCORE', 'COIN_COLLECT_RESULT', 'BOX_STATE', 'BOX_SPIN_READY', 'BOX_REWARD', 'BOX_ERROR']);
  assert.deepEqual([...after].filter(([key, value]) => !same(value, before.get(key))).map(([key]) => key),
    [...reviewed], 'Exactly the six reviewed economic receipt/score/rejection cases change');
  for (const [key, original] of before) if (!reviewed.has(key))
    assert.deepEqual(clean(after.get(key)), clean(original), `Existing non-economy socket handler remains exact: ${key}`);
  const old = parse(baseline('src/client/secure-socket-handoff.js')).body.find(node => node.id?.name === 'secureHandleSocketMessage');
  const now = parse(current('src/client/secure-socket-handoff.js')).body.find(node => node.id?.name === 'secureHandleSocketMessage');
  for (const fn of [old, now]) {
    const switchNode = fn.body.body.find(node => node.type === 'SwitchStatement');
    switchNode.cases = switchNode.cases.map(node => reviewed.has(node.test?.property.name)
      ? { reviewedEconomyPacket: node.test.property.name } : clean(node));
  }
  assert.deepEqual(clean(now), clean(old), 'Outer dispatch validation and unrelated control flow are unchanged');
});

test('P4 browser frame changes only project coin respawn against known server time', () => {
  const file = 'src/client/wheel-frame.js';
  const before = parse(baseline(file)), after = parse(current(file));
  let restored = 0;
  walk(after, node => {
    if (node.type !== 'BinaryExpression' || node.right.type !== 'MemberExpression' ||
        node.right.property.name !== 'respawnTime' || node.left.type !== 'CallExpression' ||
        node.left.callee.name !== 'secureNow') return;
    node.left = parse('nowMs').body[0].expression;
    restored++;
  });
  assert.equal(restored, 1, 'Exactly one respawn eligibility clock uses authoritative server-time offset');
  assert.deepEqual(clean(after), clean(before), 'Animation, movement prediction, controls and interaction thresholds remain exact');
});

test('P4 Lucky Box initialization adds only an explicit inactive server-state sentinel', () => {
  const file = 'src/client/secure-menu-economy.js';
  const before = units(baseline(file)).find(node => name(node) === 'assignment:spawnLuckyBoxes');
  const after = units(current(file)).find(node => name(node) === 'assignment:spawnLuckyBoxes');
  let removed = 0;
  const sentinel = parse('({serverActive:false})').body[0].expression.properties[0];
  walk(after, node => {
    if (node.type !== 'ObjectExpression') return;
    const properties = node.properties.filter(property => same(property, sentinel));
    removed += properties.length;
    node.properties = node.properties.filter(property => !same(property, sentinel));
  });
  assert.equal(removed, 1);
  assert.deepEqual(clean(after), clean(before), 'Every previous scene, mesh, timer and claim initialization is unchanged');
});

test('P4 keeps generated entrypoints, twelve-fragment order and canonical physics assembly unchanged', async () => {
  assert.equal(current('src/client/entry.mjs'), baseline('src/client/entry.mjs'));
  assert.equal(current('src/client/index.template.html'), baseline('src/client/index.template.html'));
  assert.equal(current('scripts/rebuild/build-client.cjs'), baseline('scripts/rebuild/build-client.cjs'));
  const entry = await import(pathToFileURL(path.join(ROOT, 'src/client/entry.mjs')));
  assert.equal(entry.CLIENT_SOURCES.length, 12);
  for (const key of ['config', 'protocol', 'catalog', 'movement'])
    assert.equal(entry[key], await import(pathToFileURL(path.join(ROOT, `src/shared/${key}.mjs`))));
  const authored = parse(current('src/shared/movement.mjs'), 'module').body.map(node => node.declaration || node);
  const assembled = parse(classicMovementKernel()).body[0].declarations[0].init.callee.body.body;
  assert.deepEqual(clean(assembled.slice(0, -1)), clean(authored), 'Generated physics remains the exact single authored movement AST');
  assert.ok(moduleGraph().some(module => module.file === path.join(ROOT, 'src/shared/movement.mjs')));
  assert.ok(await buildClient() === current('index.html'), 'Generated browser is current');
  const shell = html => html.replace(/<script>[\s\S]*?<\/script>/gi, '<script>ACTIVE CLIENT</script>');
  assert.equal(shell(current('index.html')), shell(baseline('index.html')));
});

test('P4 world changes cannot alter original geometry, deterministic coins or reward distribution', () => {
  const file = 'src/worker/world.mjs';
  const before = units(baseline(file), 'module'), after = units(current(file), 'module');
  for (const key of ['function:serverSeededRandom', 'function:buildServerCollisionWorld', 'variable:SERVER_WORLD',
    'function:safeWorldPosition', 'function:coinPosition', 'variable:COINS', 'function:secureLuckyReward']) {
    const original = before.find(node => name(node) === key), active = after.find(node => name(node) === key);
    assert.ok(original && active, `Original world/reward unit retained: ${key}`);
    assert.deepEqual(clean(active), clean(original), `Unchanged world/reward semantics: ${key}`);
  }
});
