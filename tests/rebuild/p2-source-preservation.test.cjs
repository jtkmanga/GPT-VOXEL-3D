'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const acorn = require('acorn');
const { ROOT, moduleGraph, walk } = require('../../scripts/rebuild/source-view.cjs');
const { buildClient } = require('../../scripts/rebuild/build-client.cjs');

// This proof runs on active P2 files. The unchanged historical P1 suite proves
// extraction equality at P1; these assertions retain its structural guarantees
// while making each deliberately changed P2 boundary explicit and reviewable.
const P1 = '10dfaf0aff07d2896c50af06d88502166b16fe9e';
const originals = new Map();
function baseline(file) {
  if (!originals.has(file)) originals.set(file,
    execFileSync('git', ['show', `${P1}:${file}`], { cwd: ROOT, encoding: 'utf8' }));
  return originals.get(file);
}
function current(file) { return fs.readFileSync(path.join(ROOT, file), 'utf8'); }
function parse(source, sourceType = 'script') {
  return acorn.parse(source, { ecmaVersion: 'latest', sourceType });
}
function normalized(value) {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(normalized);
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !['start', 'end', 'raw'].includes(key))
    .map(([key, child]) => [key, normalized(child)]));
}
const same = (left, right) => JSON.stringify(normalized(left)) === JSON.stringify(normalized(right));
const statement = source => parse(`function preservationContext() { ${source} }`).body[0].body.body[0];
function classNode(file, source) {
  const ast = parse(source, 'module');
  return ast.body.find(node => node.type === 'ExportNamedDeclaration' &&
    node.declaration?.type === 'ClassDeclaration').declaration;
}
function methods(file, source) {
  return new Map(classNode(file, source).body.body.map(node => [node.key.name, node]));
}
function copy(node) { return structuredClone(node); }
function removeExact(body, source, count, description) {
  const expected = statement(source);
  const before = body.length;
  const result = body.filter(node => !same(node, expected));
  assert.equal(before - result.length, count, description);
  return result;
}
function programUnits(source) {
  return parse(source).body.flatMap(node => node.type === 'VariableDeclaration'
    ? node.declarations.map(declaration => ({ ...node, declarations: [declaration] })) : [node]);
}
function unitName(node) {
  if (node.type === 'FunctionDeclaration') return `function:${node.id.name}`;
  if (node.type === 'VariableDeclaration') return `variable:${node.declarations[0].id.name}`;
  if (node.type === 'ExpressionStatement' && node.expression.type === 'AssignmentExpression' &&
      node.expression.left.type === 'Identifier') return `assignment:${node.expression.left.name}`;
  return null;
}
function preserveProgram(file, { added = [], changed = [] } = {}) {
  const old = programUnits(baseline(file)), now = programUnits(current(file));
  const originalNames = new Set(old.map(unitName).filter(Boolean));
  const additions = new Set(added), approved = new Set(changed), actualAdditions = [];
  const trim = nodes => nodes.flatMap(node => {
    const name = unitName(node);
    if (name && !originalNames.has(name)) {
      assert.ok(additions.has(name), `${file}: unreviewed new declaration ${name}`);
      actualAdditions.push(name);
      return [];
    }
    return [approved.has(name) ? { approvedP2Boundary: name } : normalized(node)];
  });
  const expected = trim(old), actual = trim(now);
  assert.deepEqual(actual, expected, `${file}: original ordered executable statements preserved`);
  assert.deepEqual(actualAdditions.sort(), [...additions].sort(), `${file}: exact new P2 declarations`);
  for (const name of approved) assert.ok(originalNames.has(name), `${file}: known reviewed boundary ${name}`);
}
function preserveMethods(file, { added = [], changed = [], transform = {} } = {}) {
  const old = methods(file, baseline(file)), now = methods(file, current(file));
  assert.deepEqual([...now.keys()].filter(name => !old.has(name)).sort(), [...added].sort(), `${file}: exact new P2 methods`);
  for (const [name, original] of old) {
    assert.ok(now.has(name), `${file}: original method ${name} retained`);
    if (changed.includes(name)) continue;
    const actual = transform[name] ? transform[name](copy(now.get(name))) : now.get(name);
    assert.deepEqual(normalized(actual), normalized(original), `${file}: P1 method ${name}`);
  }
  for (const name of changed) assert.ok(old.has(name), `${file}: known reviewed method ${name}`);
}
const clientAdditions = {
  'secure-entitlements-payment.js': ['variable:secureIdentityUid', 'function:secureOnIdentityChanged'],
  'secure-socket-handoff.js': [
    'variable:secureSessionTickets', 'variable:secureSocketRefreshTimers', 'variable:secureSocketRefreshExpiries',
    'variable:secureClientSockets', 'variable:secureClientWaiters', 'variable:secureClientConnectionEpoch',
    'variable:secureActiveHandoff', 'variable:secureReconnectInProgress', 'variable:secureReconnectGeneration',
    ...['secureConnectionEpoch', 'secureConnectionIsCurrent', 'secureRegisterClientSocket',
      'secureUnregisterClientSocket', 'secureStartHandoffOperation', 'secureHandoffOperationIsCurrent',
      'secureRequireHandoffOperation', 'secureFinishHandoffOperation', 'secureAbortClientConnections',
      'secureClientDelay', 'secureSessionKey', 'secureGetResumeTicket', 'secureRememberSession',
      'secureClearSocketRefresh', 'secureForgetResumeTicket', 'secureTrackAuthenticatedSocket',
      'secureCancelReconnect', 'secureResumeDisconnectedSocket'].map(name => `function:${name}`)
  ]
};

test('P2 active generated client retains the twelve-fragment manifest and canonical shared imports', async () => {
  assert.equal(current('src/client/entry.mjs'), baseline('src/client/entry.mjs'));
  const entry = await import(pathToFileURL(path.join(ROOT, 'src/client/entry.mjs')));
  assert.equal(entry.CLIENT_SOURCES.length, 12);
  for (const name of ['config', 'protocol', 'catalog']) {
    assert.equal(entry[name], await import(pathToFileURL(path.join(ROOT, `src/shared/${name}.mjs`))));
  }
  assert.equal(await buildClient(), current('index.html'), 'Active generated browser entrypoint is current');
});

test('P2 original HTML shell and source assembly helpers remain unchanged', () => {
  for (const file of ['src/client/index.template.html', 'scripts/rebuild/build-client.cjs', 'scripts/rebuild/source-view.cjs']) {
    assert.equal(current(file), baseline(file), file);
  }
  const shell = html => html.replace(/<script>[\s\S]*?<\/script>/gi, '<script>ACTIVE CLIENT</script>');
  assert.equal(shell(current('index.html')), shell(baseline('index.html')));
});

test('P2 nonsecurity client scripts and SDK callback preserve the original executable AST', () => {
  for (const name of ['audio.js', 'firebase-multiplayer.js', 'menu-shop.js', 'world.js', 'controls.js', 'wheel-frame.js']) {
    const file = `src/client/${name}`;
    assert.deepEqual(normalized(parse(current(file))), normalized(parse(baseline(file))), file);
  }
  const file = 'src/client/auth-state.js', old = parse(baseline(file)), now = parse(current(file));
  let hooks = 0;
  walk(now, node => {
    if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression' &&
        node.callee.object.name === 'auth' && node.callee.property.name === 'onAuthStateChanged') {
      node.arguments[0].body.body = removeExact(node.arguments[0].body.body,
        "if (typeof secureOnIdentityChanged === 'function') secureOnIdentityChanged(user);", 1, 'Single SDK identity hook');
      hooks++;
    }
  });
  assert.equal(hooks, 1);
  assert.deepEqual(normalized(now), normalized(old), 'Existing SDK listener and all original auth/state code retained');
});

test('P2 security client changes use an explicit declaration and function allowlist', () => {
  preserveProgram('src/client/secure-entitlements-payment.js', {
    added: clientAdditions['secure-entitlements-payment.js'], changed: ['function:secureLoadEntitlements']
  });
  preserveProgram('src/client/secure-socket-handoff.js', {
    added: clientAdditions['secure-socket-handoff.js'], changed: [
      'function:secureHandleSocketMessage', 'function:secureOpenZoneSocket', 'function:secureBeginZoneHandoff',
      'function:secureResumeHandoffOnTarget', 'function:secureConnectGameSocket'
    ]
  });
  preserveProgram('src/client/secure-snapshots.js');
  for (const [name, functionName, hook] of [
    ['secure-menu-economy.js', 'secureReturnToMenu', "if (typeof secureAbortClientConnections === 'function') secureAbortClientConnections('Returned to menu');"],
    ['secure-wheel-startup.js', 'confirmExitGame', "if (typeof secureAbortClientConnections === 'function') secureAbortClientConnections('Exit game');"]
  ]) {
    const file = `src/client/${name}`, now = parse(current(file));
    let removed = 0;
    walk(now, node => {
      const body = node.type === 'FunctionDeclaration' && node.id.name === functionName ? node.body :
        node.type === 'AssignmentExpression' && node.left.name === functionName ? node.right.body : null;
      if (!body) return;
      assert.ok(same(body.body[0], statement(hook)), `${functionName}: cleanup is the only added prefix`);
      body.body.shift(); removed++;
    });
    assert.equal(removed, 1);
    assert.deepEqual(normalized(now), normalized(parse(baseline(file))), `${file}: original world/economy/startup code retained`);
  }
});

test('P2 original movement, world, score, leaderboard and wheel message handlers remain unchanged', () => {
  const file = 'src/client/secure-socket-handoff.js';
  const cases = source => {
    const fn = parse(source).body.find(node => node.type === 'FunctionDeclaration' && node.id.name === 'secureHandleSocketMessage');
    return new Map(fn.body.body.find(node => node.type === 'SwitchStatement').cases.map(node => [node.test.property.name, node]));
  };
  const old = cases(baseline(file)), now = cases(current(file));
  assert.deepEqual([...now.keys()].filter(key => !old.has(key)), ['AUTH_REFRESHED']);
  for (const [name, original] of old) {
    assert.ok(now.has(name), `Original handler retained: ${name}`);
    const actual = copy(now.get(name));
    if (name === 'HANDOFF_RESUMED') actual.consequent = removeExact(actual.consequent,
      "if (typeof secureTrackAuthenticatedSocket === 'function' && secureGameSocket) { secureTrackAuthenticatedSocket(secureGameSocket, message.zone || secureCurrentZoneId, message.session); }",
      1, 'Only handoff session metadata tracking added to existing ACK handler');
    assert.deepEqual(normalized(actual), normalized(original), `Existing packet behavior preserved: ${name}`);
  }
});

test('P2 active Worker module graph retains P1 modules and unchanged HTTP, routing, spatial and world code', () => {
  const oldFiles = execFileSync('git', ['ls-tree', '-r', '--name-only', P1, 'src/worker'], { cwd: ROOT, encoding: 'utf8' }).trim().split('\n');
  const active = moduleGraph().map(module => path.relative(ROOT, module.file));
  for (const file of oldFiles) assert.ok(active.includes(file), `P1 module retained: ${file}`);
  assert.deepEqual(active.filter(file => file.startsWith('src/worker/') && !oldFiles.includes(file)).sort(),
    ['src/worker/room-security.mjs', 'src/worker/security.mjs', 'src/worker/sessions.mjs']);
  for (const file of ['src/worker/http.mjs', 'src/worker/router.mjs', 'src/worker/spatial.mjs', 'src/worker/world.mjs']) {
    assert.equal(current(file), baseline(file), `${file}: every original declaration and import is byte-identical`);
  }
  for (const file of ['worker.js', 'wrangler.jsonc', 'src/shared/config.mjs', 'src/shared/catalog.mjs', 'src/shared/protocol.mjs']) {
    assert.equal(current(file), baseline(file), `${file}: original public contract and shared values`);
  }
});

test('P2 GameRoom preserves movement and economy bodies after only the exact session guard', () => {
  const guard = 'if (!this.ownsSession(ws,p)) return;';
  const stripGuard = node => {
    assert.ok(same(node.value.body.body[0], statement(guard)), 'Exact authoritative ownership guard is first');
    node.value.body.body.shift();
    return node;
  };
  preserveMethods('src/worker/game-room.mjs', {
    added: ['sessionOwner', 'sessionCall', 'revokeSession', 'revokeOwner', 'entitlementSnapshot', 'ownsSession', 'ownsZoneSession', 'closeSession'],
    changed: ['constructor', 'count', 'broadcast', 'nearbySockets', 'fetch', 'webSocketMessage', 'handleAuth', 'webSocketClose', 'webSocketError'],
    transform: Object.fromEntries(['handleMove', 'handleCollect', 'handleCollectBox', 'handleSpinBox'].map(name => [name, stripGuard]))
  });
});

test('P2 ZoneRoom preserves movement and economy bodies after only server session fields', () => {
  const fields = { sessionId: parse('({sessionId:p.sessionId})').body[0].expression.properties[0],
    owner: parse('({owner:this.sessionOwner()})').body[0].expression.properties[0] };
  const stripFields = keys => node => {
    const removed = Object.fromEntries(keys.map(key => [key, 0]));
    walk(node, value => {
      if (value.type !== 'CallExpression' || value.callee.type !== 'MemberExpression' ||
          value.callee.object.name !== 'JSON' || value.callee.property.name !== 'stringify' ||
          value.arguments[0]?.type !== 'ObjectExpression') return;
      value.arguments[0].properties = value.arguments[0].properties.filter(property => {
        const key = property.key?.name;
        if (!keys.includes(key)) return true;
        assert.ok(same(property, fields[key]), `Exact server-owned request field: ${key}`);
        removed[key]++;
        return false;
      });
    });
    for (const key of keys) assert.equal(removed[key], 1, `Exactly one ${key} added to the original internal request`);
    return node;
  };
  preserveMethods('src/worker/zone-room.mjs', {
    added: ['activePlayer', 'sessionOwner', 'sessionCall', 'authenticationExpired', 'dispatchMessage', 'endSession'],
    changed: ['constructor', 'count', 'broadcastAll', 'nearbySockets', 'borderPlayers', 'fetch', 'webSocketMessage', 'handleAuth', 'handleHandoffResume', 'webSocketClose', 'webSocketError'],
    transform: { handleMove: stripFields(['sessionId']), handleCollect: stripFields(['sessionId', 'owner']),
      handleCollectBox: stripFields(['sessionId', 'owner']), handleSpinBox: stripFields(['sessionId', 'owner']) }
  });
});

test('P2 retained bootstrap, entitlement, payment, world routes and constructor state stay unchanged', () => {
  for (const file of ['src/worker/game-room.mjs', 'src/worker/zone-room.mjs']) {
    const old = methods(file, baseline(file)), now = methods(file, current(file));
    const isGame = file.endsWith('game-room.mjs');
    const constructor = copy(now.get('constructor'));
    constructor.value.body.body = removeExact(constructor.value.body.body,
      'for (const ws of this.sockets()) scheduleAuthDeadline(this,ws);', 1, `${file}: only timer rearm added`);
    if (isGame) {
      constructor.value.body.body = removeExact(constructor.value.body.body, 'this.sessions=new SessionStore(ctx);', 1, 'One durable session store added');
      constructor.value.body.body = removeExact(constructor.value.body.body,
        "try { this.sql.exec('ALTER TABLE voxel_zone_handoffs ADD COLUMN session_id TEXT'); } catch (_) {}", 1, 'One handoff-session schema extension');
      let schemas = 0;
      walk(constructor, node => {
        if (node.type === 'TemplateLiteral' && node.quasis.length === 1 &&
            node.quasis[0].value.raw.includes('CREATE TABLE IF NOT EXISTS voxel_zone_handoffs')) {
          for (const key of ['raw', 'cooked']) node.quasis[0].value[key] =
            node.quasis[0].value[key].replace(',\n      session_id TEXT', '');
          schemas++;
        }
      });
      assert.equal(schemas, 1);
    }
    assert.deepEqual(normalized(constructor), normalized(old.get('constructor')), `${file}: original persistent state setup preserved`);

    const route = node => {
      if (node.type !== 'IfStatement') return null;
      const literals = [];
      walk(node.test, item => { if (item.type === 'Literal' && typeof item.value === 'string' && item.value.startsWith('/_internal/')) literals.push(item.value); });
      return literals[0] || null;
    };
    const originalRoutes = new Map(old.get('fetch').value.body.body.filter(route).map(node => [route(node), node]));
    const activeRoutes = new Map(now.get('fetch').value.body.body.filter(route).map(node => [route(node), node]));
    const newRoute = isGame ? '/_internal/session/' : '/_internal/session-revoke';
    assert.deepEqual([...activeRoutes.keys()].filter(key => !originalRoutes.has(key)), [newRoute]);
    const changedHandoff = new Set(['/_internal/create-zone-handoff', '/_internal/consume-zone-handoff']);
    for (const [name, original] of originalRoutes) {
      assert.ok(activeRoutes.has(name), `Original internal route retained: ${name}`);
      if (isGame && changedHandoff.has(name)) continue;
      const actual = copy(activeRoutes.get(name));
      if (isGame && ['/_internal/zone-collect', '/_internal/zone-collect-box', '/_internal/zone-spin-box'].includes(name)) {
        actual.consequent.body = removeExact(actual.consequent.body,
          "if (!this.ownsZoneSession(body,uid)) return Response.json({ok:false,error:'Session no longer owned'},{status:403});",
          1, `${name}: only session-authority prefix added`);
      }
      if (!isGame && name === '/_internal/border-snapshot') {
        const activeFilter = parse('while (true) { if (!this.activePlayer(p)) continue; }').body[0].body.body[0];
        const originalFilter = parse('while (true) { if (!p?.uid) continue; }').body[0].body.body[0];
        let filters = 0;
        walk(actual, node => {
          if (same(node, activeFilter)) {
            Object.assign(node, originalFilter);
            filters++;
          }
        });
        assert.equal(filters, 1, 'Border visibility only adds active-session filtering');
      }
      assert.deepEqual(normalized(actual), normalized(original), `Original route behavior preserved: ${name}`);
    }
  }
});
