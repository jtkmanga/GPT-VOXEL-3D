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

// P2's complete, unmodified source-freeze proof runs against its real checkpoint.
// This active proof bounds P3's movement changes and keeps all other executable
// statements, server economy methods and public configuration under comparison.
const P2 = 'e7ce2674f66f8d7c7f22efb669bd506e5359bceb';
const oldSources = new Map();
function baseline(file) {
  if (!oldSources.has(file)) oldSources.set(file,
    execFileSync('git', ['show', `${P2}:${file}`], { cwd: ROOT, encoding: 'utf8' }));
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
const statement = source => parse(`function proofContext() { ${source} }`).body[0].body.body[0];
function remove(body, source, description) {
  const expected = statement(source), matches = body.filter(node => same(node, expected));
  assert.equal(matches.length, 1, description);
  return body.filter(node => !same(node, expected));
}
function methods(source) {
  const declaration = parse(source, 'module').body.find(node => node.declaration?.type === 'ClassDeclaration').declaration;
  return new Map(declaration.body.body.map(node => [node.key.name, node]));
}
function units(source) {
  return parse(source).body.flatMap(node => node.type === 'VariableDeclaration'
    ? node.declarations.map(item => ({ ...node, declarations: [item] })) : [node]);
}
function name(node) {
  if (node.type === 'FunctionDeclaration') return `function:${node.id.name}`;
  if (node.type === 'VariableDeclaration') return `variable:${node.declarations[0].id.name}`;
  if (node.type === 'ExpressionStatement' && node.expression.type === 'AssignmentExpression' &&
      node.expression.left.type === 'Identifier') return `assignment:${node.expression.left.name}`;
  return null;
}
function preserveClient(file, changed = [], added = []) {
  const old = units(baseline(file)), now = units(current(file));
  const originalNames = new Set(old.map(name).filter(Boolean));
  const addedNames = now.map(name).filter(key => key && !originalNames.has(key));
  assert.deepEqual(addedNames.sort(), [...added].sort(), `${file}: exact new movement declarations`);
  const changedNames = new Set(changed);
  for (const key of changedNames) assert.ok(originalNames.has(key), `${file}: known movement boundary ${key}`);
  const bounded = body => body.filter(node => !addedNames.includes(name(node)))
    .map(node => changedNames.has(name(node)) ? { reviewedMovementBoundary: name(node) } : clean(node));
  assert.deepEqual(bounded(now), bounded(old), `${file}: every other ordered executable statement is preserved`);
}
function welcomeWithoutMotion(method, zone = false) {
  method = structuredClone(method);
  method.value.body.body = remove(method.value.body.body, 'initializeMotion(p,now);', 'One server motion initializer');
  let welcomeCount = 0;
  walk(method, node => {
    if (node.type !== 'ObjectExpression' || !node.properties.some(property =>
      property.key?.name === 'type' && property.value.type === 'MemberExpression' && property.value.property.name === 'WELCOME')) return;
    const property = parse('({movement:publicMovement(p)})').body[0].expression.properties[0];
    const found = node.properties.filter(item => same(item, property));
    assert.equal(found.length, 1, 'Exactly one authoritative movement metadata field in welcome');
    node.properties = node.properties.filter(item => !same(item, property));
    welcomeCount++;
  });
  assert.equal(welcomeCount, 1);
  if (zone) {
    let fences = 0;
    const tokenProperty = parse('({token:handoffToken})').body[0].expression.properties[0];
    walk(method, node => {
      if (node.type !== 'Property' || node.key?.name !== 'handoffResume' ||
          node.value.type !== 'ConditionalExpression') return;
      const fields = node.value.consequent.properties;
      assert.equal(fields.filter(item => same(item, tokenProperty)).length, 1,
        'The provisional transfer stores exactly its private server-issued fence token');
      node.value.consequent.properties = fields.filter(item => !same(item, tokenProperty));
      fences++;
    });
    assert.equal(fences, 1);
  }
  return method;
}

test('P3 retains byte-identical public endpoints, auth verifier, sessions, economy catalog and production bindings', () => {
  for (const file of ['worker.js', 'wrangler.jsonc', 'src/shared/config.mjs', 'src/shared/protocol.mjs',
    'src/shared/catalog.mjs', 'src/worker/http.mjs', 'src/worker/router.mjs', 'src/worker/firebase-auth.mjs',
    'src/worker/sessions.mjs', 'src/worker/room-security.mjs', 'src/worker/spatial.mjs', 'src/worker/world.mjs']) {
    assert.equal(current(file), baseline(file), file);
  }
  const oldFiles = execFileSync('git', ['ls-tree', '-r', '--name-only', P2, 'src/worker'], { cwd: ROOT, encoding: 'utf8' }).trim().split('\n');
  const active = moduleGraph().map(module => path.relative(ROOT, module.file));
  for (const file of oldFiles) assert.ok(active.includes(file), `P2 Worker module retained: ${file}`);
  assert.deepEqual(active.filter(file => file.startsWith('src/worker/') && !oldFiles.includes(file)), ['src/worker/movement.mjs']);
});

test('P3 shares the authored deterministic movement kernel between Worker and generated browser', async () => {
  const entry = await import(pathToFileURL(path.join(ROOT, 'src/client/entry.mjs')));
  const oldEntrySource = baseline('src/client/entry.mjs');
  const oldManifest = parse(oldEntrySource, 'module').body.find(node => node.declaration?.declarations?.[0]?.id.name === 'CLIENT_SOURCES').declaration;
  const manifest = parse(current('src/client/entry.mjs'), 'module').body.find(node => node.declaration?.declarations?.[0]?.id.name === 'CLIENT_SOURCES').declaration;
  assert.deepEqual(clean(manifest), clean(oldManifest));
  assert.equal(entry.CLIENT_SOURCES.length, 12);
  for (const key of ['config', 'protocol', 'catalog', 'movement'])
    assert.equal(entry[key], await import(pathToFileURL(path.join(ROOT, `src/shared/${key}.mjs`))));
  const authored = parse(current('src/shared/movement.mjs'), 'module').body.map(node => node.declaration || node);
  const assembled = parse(classicMovementKernel()).body[0].declarations[0].init.callee.body.body;
  assert.equal(assembled.at(-1).type, 'ReturnStatement');
  assert.deepEqual(clean(assembled.slice(0, -1)), clean(authored), 'Browser physics is assembled from the exact canonical authored AST');
  assert.ok(moduleGraph().some(module => module.file === path.join(ROOT, 'src/shared/movement.mjs')), 'Worker loads that same authored module');
  assert.ok(await buildClient() === current('index.html'), 'Active generated browser entrypoint is current');
  const shell = html => html.replace(/<script>[\s\S]*?<\/script>/gi, '<script>ACTIVE CLIENT</script>');
  assert.equal(shell(current('index.html')), shell(baseline('index.html')));
  assert.equal(current('src/client/index.template.html'), baseline('src/client/index.template.html'));
});

test('P3 leaves all nonmovement client fragments and SDK identity/entitlement behavior unchanged', () => {
  for (const file of ['auth-state.js', 'audio.js', 'firebase-multiplayer.js', 'menu-shop.js', 'world.js',
    'secure-entitlements-payment.js', 'secure-snapshots.js', 'secure-wheel-startup.js']) {
    assert.deepEqual(clean(parse(current(`src/client/${file}`))), clean(parse(baseline(`src/client/${file}`))), file);
  }
  const file = 'src/client/controls.js', now = parse(current(file));
  let hooks = 0;
  walk(now, node => {
    if (node.type === 'FunctionDeclaration' && node.id.name === 'triggerJump') {
      node.body.body[0].consequent.body = remove(node.body.body[0].consequent.body,
        "if (typeof secureQueueJump === 'function') secureQueueJump();", 'Only a movement intent hook is added to the existing jump control');
      hooks++;
    }
  });
  assert.equal(hooks, 1);
  assert.deepEqual(clean(now), clean(parse(baseline(file))), 'All original control mappings, touch handlers and jump effects remain');
});

test('P3 client changes have exact bounded movement declarations and preserved nonmovement socket cases', () => {
  preserveClient('src/client/secure-menu-economy.js', ['assignment:collectCoin', 'assignment:syncMyPlayerData']);
  preserveClient('src/client/wheel-frame.js', ['function:gameLoop']);
  preserveClient('src/client/secure-socket-handoff.js', ['function:secureHandleSocketMessage',
    'function:secureResumeHandoffOnTarget', 'function:secureBeginZoneHandoff'], [
    ...['secureInputSequence', 'secureLastAcknowledgedSequence', 'secureJumpIntent',
      'secureJumpGeneration', 'secureJumpHeld', 'securePendingFrames', 'securePendingInputs',
      'securePredictionCorrection'].map(key => `variable:${key}`),
    ...['secureQueueJump', 'secureMovementIntent', 'secureMovementState', 'secureApplyMovementState',
      'secureMovementOptions', 'securePredictMovement', 'secureResetPrediction', 'secureReconcileMovement'].map(key => `function:${key}`)
  ]);
  const cases = source => {
    const fn = parse(source).body.find(node => node.type === 'FunctionDeclaration' && node.id.name === 'secureHandleSocketMessage');
    return new Map(fn.body.body.find(node => node.type === 'SwitchStatement').cases.map(node => [node.test.property.name, node]));
  };
  const old = cases(baseline('src/client/secure-socket-handoff.js')), now = cases(current('src/client/secure-socket-handoff.js'));
  assert.deepEqual([...now.keys()].filter(key => !old.has(key)), ['HANDOFF_CANCELLED'],
    'Only the existing canonical cancellation ACK gains a movement rollback handler');
  assert.deepEqual([...now.keys()].filter(key => key !== 'HANDOFF_CANCELLED'), [...old.keys()],
    'Every existing socket handler is retained in order');
  for (const [key, original] of old) {
    if (['WELCOME', 'MOVE', 'HANDOFF_RESUMED', 'HANDOFF_CANCELLED'].includes(key)) continue;
    assert.deepEqual(clean(now.get(key)), clean(original), `Original nonmovement socket packet handler: ${key}`);
  }
});

test('P3 preserves the existing client coin and Lucky Box detection/render loops exactly', () => {
  const file = 'src/client/wheel-frame.js';
  const economyNodes = source => {
    const found = [];
    walk(parse(source), node => {
      if (node.type === 'ExpressionStatement' && node.expression.type === 'CallExpression' &&
          node.expression.callee.type === 'MemberExpression' && node.expression.callee.object.name === 'coins' &&
          node.expression.callee.property.name === 'forEach') found.push(node);
      if (node.type === 'IfStatement' && node.test.type === 'Identifier' && node.test.name === 'luckyBox') found.push(node);
    });
    return found;
  };
  const old = economyNodes(baseline(file)), now = economyNodes(current(file));
  assert.equal(old.length, 2);
  assert.deepEqual(clean(now), clean(old), 'Economy interaction thresholds, timers, widgets and visual effects remain unchanged');
});

test('P3 auth changes add only motion metadata and the private provisional handoff fence', () => {
  for (const file of ['src/worker/game-room.mjs', 'src/worker/zone-room.mjs']) {
    const old = methods(baseline(file)), now = methods(current(file));
    assert.deepEqual(clean(welcomeWithoutMotion(now.get('handleAuth'), file.endsWith('zone-room.mjs'))),
      clean(old.get('handleAuth')), `${file}: Firebase verification, UID, session races and entitlements preserved`);
  }
});

test('P3 keeps every GameRoom economy, persistence, leaderboard and entitlement method unchanged', () => {
  const file = 'src/worker/game-room.mjs', old = methods(baseline(file)), now = methods(current(file));
  const reviewed = new Set(['constructor', 'sessionCall', 'fetch', 'handleAuth', 'handleMove']);
  assert.deepEqual([...now.keys()], [...old.keys()], 'No unrelated GameRoom methods added, removed or reordered');
  for (const [key, original] of old) {
    if (reviewed.has(key)) continue;
    assert.deepEqual(clean(now.get(key)), clean(original), `GameRoom preserved method: ${key}`);
  }
  const constructor = structuredClone(now.get('constructor'));
  const originalStatements = old.get('constructor').value.body.body;
  const newStatements = constructor.value.body.body.filter(node => !originalStatements.some(item => same(node, item)));
  assert.equal(newStatements.length, 1, 'Only one durable handoff fence table is added to existing state setup');
  assert.equal(newStatements[0].type, 'ExpressionStatement');
  const template = newStatements[0].expression.arguments[0];
  assert.equal(template.type, 'TemplateLiteral');
  assert.match(template.quasis[0].value.cooked, /^CREATE TABLE IF NOT EXISTS voxel_handoff_grants \(/);
  constructor.value.body.body = constructor.value.body.body.filter(node => !same(node, newStatements[0]));
  assert.deepEqual(clean(constructor), clean(old.get('constructor')), 'Existing economy SQL schemas and startup recovery remain exact');
});

test('P3 preserves all existing internal economy/bootstrap/payment routes while adding only handoff cancellation', () => {
  const file = 'src/worker/game-room.mjs', old = methods(baseline(file)).get('fetch'), now = methods(current(file)).get('fetch');
  const route = node => {
    if (node.type !== 'IfStatement') return null;
    const paths = [];
    walk(node.test, item => { if (item.type === 'Literal' && typeof item.value === 'string' && item.value.startsWith('/_internal/')) paths.push(item.value); });
    return paths[0] || null;
  };
  const before = new Map(old.value.body.body.filter(route).map(node => [route(node), node]));
  const after = new Map(now.value.body.body.filter(route).map(node => [route(node), node]));
  assert.deepEqual([...after.keys()].filter(key => !before.has(key)), ['/_internal/cancel-zone-handoff']);
  for (const [key, original] of before) {
    assert.ok(after.has(key), `Original route retained: ${key}`);
    if (['/_internal/create-zone-handoff', '/_internal/consume-zone-handoff'].includes(key)) continue;
    assert.deepEqual(clean(after.get(key)), clean(original), `Existing authoritative economy/session/bootstrap/payment route: ${key}`);
  }
  const replace = body => body.filter(node => route(node) !== '/_internal/cancel-zone-handoff')
    .map(node => ['/_internal/create-zone-handoff', '/_internal/consume-zone-handoff'].includes(route(node))
      ? { reviewedHandoffFence: route(node) } : clean(node));
  assert.deepEqual(replace(now.value.body.body), replace(old.value.body.body), 'All fetch behavior outside the reviewed handoff fence routes is exact');
});

test('P3 ZoneRoom economy changes remove only client contact-position authority', () => {
  const file = 'src/worker/zone-room.mjs', old = methods(baseline(file)), now = methods(current(file));
  assert.deepEqual([...now.keys()].filter(key => !old.has(key)), ['sendMovementAck']);
  const reviewed = new Set(['dispatchMessage', 'handleAuth', 'handleHandoffResume', 'handleMove', 'handleCollect']);
  for (const [key, original] of old) {
    if (reviewed.has(key)) continue;
    assert.deepEqual(clean(now.get(key)), clean(original), `ZoneRoom preserved method: ${key}`);
  }
  const collect = structuredClone(old.get('handleCollect'));
  const contactDeclaration = collect.value.body.body.find(node => node.type === 'VariableDeclaration' && node.declarations[0].id.name === 'cx');
  assert.ok(contactDeclaration, 'Pinned P2 contains the original client contact-position declaration');
  const contactIndex = collect.value.body.body.indexOf(contactDeclaration);
  assert.equal(collect.value.body.body[contactIndex + 1].type, 'IfStatement');
  const contactBody = collect.value.body.body[contactIndex + 1];
  let clientMutation = 0;
  walk(contactBody, node => {
    if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression' &&
        node.callee.object.name === 'Object' && node.callee.property.name === 'assign' &&
        node.arguments[0].name === 'p') clientMutation++;
  });
  assert.equal(clientMutation, 1, 'The removed branch is exactly the former client-authoritative position mutation');
  collect.value.body.body.splice(contactIndex, 2);
  assert.deepEqual(clean(now.get('handleCollect')), clean(collect), 'Collection throttles, coordinator request, reward/state messages and errors are otherwise exact');
});

test('P3 retains every auth, rate, secret-field and nonmovement schema validation from P2', () => {
  const file = 'src/worker/security.mjs';
  const securityUnits = source => parse(source, 'module').body.map(node => node.declaration || node);
  const old = securityUnits(baseline(file)), now = securityUnits(current(file));
  const unitKey = node => node.type === 'ImportDeclaration' ? `import:${node.source.value}` :
    node.type === 'FunctionDeclaration' ? `function:${node.id.name}` :
      node.type === 'VariableDeclaration' ? `variable:${node.declarations[0].id.name}` : null;
  const approved = new Set(['variable:incomingFields', 'function:parseFrame']);
  const added = now.filter(node => !old.some(item => unitKey(item) === unitKey(node)));
  assert.equal(added.length, 1);
  assert.equal(unitKey(added[0]), 'import:../shared/movement.mjs');
  const bounded = body => body.filter(node => unitKey(node) !== 'import:../shared/movement.mjs')
    .map(node => approved.has(unitKey(node)) ? { reviewedMovementSchema: unitKey(node) } : clean(node));
  assert.deepEqual(bounded(now), bounded(old), 'All unchanged security helpers, limits and authority denylist are exact');
  const entries = body => body.find(node => unitKey(node) === 'variable:incomingFields').declarations[0].init.arguments[0].elements;
  const before = new Map(entries(old).map(node => [node.elements[0].property.name, node]));
  const after = new Map(entries(now).map(node => [node.elements[0].property.name, node]));
  assert.deepEqual([...after.keys()], [...before.keys()]);
  for (const [key, original] of before) if (!['MOVE', 'HANDOFF_RESUME'].includes(key))
    assert.deepEqual(clean(after.get(key)), clean(original), `Nonmovement inbound fields remain exact: ${key}`);
  // Replace just the movement branches in the actual if-chain. This comparison
  // retains JSON/binary/oversize, rate limits, auth fields and economy checks.
  const originalParser = structuredClone(old.find(node => unitKey(node) === 'function:parseFrame'));
  const activeParser = structuredClone(now.find(node => unitKey(node) === 'function:parseFrame'));
  const findAuthChain = fn => fn.body.body.find(node => node.type === 'IfStatement' &&
    node.test.type === 'BinaryExpression' && node.test.right.type === 'MemberExpression' && node.test.right.property.name === 'AUTH');
  const originalChain = findAuthChain(originalParser), activeChain = findAuthChain(activeParser);
  assert.ok(originalChain && activeChain);
  assert.equal(originalChain.alternate.test.type, 'LogicalExpression');
  assert.equal(activeChain.alternate.test.right.property.name, 'MOVE');
  assert.equal(activeChain.alternate.alternate.test.right.property.name, 'HANDOFF_RESUME');
  const remainingNonmovement = activeChain.alternate.alternate.alternate;
  activeChain.alternate = structuredClone(originalChain.alternate);
  activeChain.alternate.alternate = remainingNonmovement;
  assert.deepEqual(clean(activeParser), clean(originalParser), 'Only movement/transfer input validation is replaced; every other validation remains exact');
});
