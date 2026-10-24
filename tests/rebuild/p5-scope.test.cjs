'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const acorn = require('acorn');
const { ROOT, moduleGraph, walk } = require('../../scripts/rebuild/source-view.cjs');
const { buildClient } = require('../../scripts/rebuild/build-client.cjs');

// Active comparisons to the real pushed P4 rebuild checkpoint. Phase-bound
// historical AST proofs supplement, rather than replace, active runtime tests.
const P4 = '149ecd9f4c617dd432e3536443be7b3081827c9b';
const previous = new Map();
const baseline = file => {
  if (!previous.has(file)) previous.set(file, execFileSync('git', ['show', `${P4}:${file}`],
    { cwd: ROOT, encoding: 'utf8' }));
  return previous.get(file);
};
const current = file => fs.readFileSync(path.join(ROOT, file), 'utf8');
const parse = source => acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
function clean(value) {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(clean);
  return Object.fromEntries(Object.entries(value).filter(([key]) => !['start', 'end', 'raw'].includes(key))
    .map(([key, child]) => [key, clean(child)]));
}
function methods(source) {
  const node = parse(source).body.find(item => item.declaration?.type === 'ClassDeclaration');
  assert.ok(node, 'An actual exported Durable Object class is present');
  return new Map(node.declaration.body.body.map(item => [item.key.name, item]));
}
function route(node) {
  if (node.type !== 'IfStatement') return null;
  const found = [];
  walk(node.test, item => {
    if (item.type === 'Literal' && typeof item.value === 'string' && item.value.startsWith('/_internal/'))
      found.push(item.value);
  });
  return found[0] || null;
}
const same = (a, b) => JSON.stringify(clean(a)) === JSON.stringify(clean(b));
const statement = source => parse(`async function context() { ${source} }`).body[0].body.body[0];
function remove(body, source, description) {
  const expected = statement(source);
  assert.equal(body.filter(node => same(node, expected)).length, 1, description);
  return body.filter(node => !same(node, expected));
}

test('P5 preserves the exact canonical world, movement, economy, auth, protocol and public bindings', () => {
  for (const file of ['worker.js', 'wrangler.jsonc', 'src/shared/config.mjs', 'src/shared/catalog.mjs',
    'src/shared/protocol.mjs', 'src/shared/movement.mjs', 'src/worker/firebase-auth.mjs',
    'src/worker/security.mjs', 'src/worker/sessions.mjs',
    'src/worker/movement.mjs', 'src/worker/world.mjs', 'src/worker/economy.mjs',
    'src/worker/spatial.mjs', 'src/worker/http.mjs', 'src/worker/router.mjs']) {
    assert.equal(current(file), baseline(file), file);
  }
});

test('P5 preserves every unrelated browser fragment and the canonical generated entrypoint', async () => {
  const files = execFileSync('git', ['ls-tree', '-r', '--name-only', P4, 'src/client'],
    { cwd: ROOT, encoding: 'utf8' }).trim().split('\n');
  for (const file of [...files.filter(file => file !== 'src/client/secure-socket-handoff.js'), 'scripts/rebuild/build-client.cjs'])
    assert.equal(current(file), baseline(file), file);
  assert.equal(current('index.html'), await buildClient(), 'Generated client is the actual canonical assembly');
  const shell = html => html.replace(/<script>[\s\S]*?<\/script>/gi, '<script>ACTIVE CLIENT</script>');
  assert.equal(shell(current('index.html')), shell(baseline('index.html')), 'Browser shell and external scripts remain exact');
});

test('P5 preserves all payment, entitlement and authoritative economic method implementations', () => {
  const file = 'src/worker/game-room.mjs';
  const before = methods(baseline(file)), after = methods(current(file));
  for (const name of ['entitlementSnapshot', 'ownsSession', 'ownsZoneSession', 'coinSnapshot',
    'economyPlayers', 'scheduleEconomyAlarm', 'alarm', 'economyPosition', 'publishCoin',
    'publishBox', 'top', 'grantPayment', 'boxSnapshot', 'handleCollect', 'handleCollectBox', 'handleSpinBox']) {
    assert.deepEqual(clean(after.get(name)), clean(before.get(name)), name);
  }
});

test('P5 preserves every economic and payment internal route including persisted contact authority', () => {
  const file = 'src/worker/game-room.mjs';
  const before = methods(baseline(file)).get('fetch').value.body.body;
  const after = methods(current(file)).get('fetch').value.body.body;
  for (const pathname of ['/_internal/get-entitlements', '/_internal/grant-payment',
    '/_internal/zone-bootstrap', '/_internal/zone-collect', '/_internal/zone-collect-box', '/_internal/zone-spin-box']) {
    const old = before.filter(node => route(node) === pathname);
    const active = after.filter(node => route(node) === pathname);
    assert.equal(old.length, 1, `Original economic/payment route exists: ${pathname}`);
    assert.equal(active.length, 1, `Exactly one active economic/payment route: ${pathname}`);
    assert.deepEqual(clean(active[0]), clean(old[0]), pathname);
  }
});

test('P5 keeps a single active economy store owned exclusively by GameRoom', () => {
  const graph = moduleGraph();
  const economic = graph.filter(item => item.file === path.join(ROOT, 'src/worker/economy.mjs'));
  assert.equal(economic.length, 1);
  const constructors = [];
  for (const module of graph) walk(module.ast, node => {
    if (node.type === 'NewExpression' && node.callee.name === 'EconomyStore')
      constructors.push(path.relative(ROOT, module.file));
  });
  assert.deepEqual(constructors, ['src/worker/game-room.mjs'],
    'Movement partitioning cannot instantiate per-zone coin/Lucky Box/reward authorities');
  const zone = parse(current('src/worker/zone-room.mjs'));
  assert.equal(zone.body.filter(node => node.type === 'ImportDeclaration' && node.source.value === './economy.mjs').length, 0);
});

test('P5 GameRoom changes only durable live-zone routing and its private query route', () => {
  const file = 'src/worker/game-room.mjs';
  const before = methods(baseline(file)), after = methods(current(file));
  assert.deepEqual([...after.keys()].filter(key => !before.has(key)), ['activeZoneIds']);
  assert.deepEqual([...after.keys()].filter(key => key !== 'activeZoneIds'), [...before.keys()],
    'No existing method is removed or reordered');
  const reviewed = new Set(['constructor', 'fetch', 'sendZoneEvent', 'sendAllZones']);
  for (const [key, original] of before) if (!reviewed.has(key))
    assert.deepEqual(clean(after.get(key)), clean(original), `Original GameRoom method preserved: ${key}`);

  const indexStatement = parse('this.sql.exec("CREATE INDEX IF NOT EXISTS voxel_sessions_routing_idx ON voxel_sessions(owner,lease_expires,exp)");').body[0];
  const constructor = after.get('constructor');
  const added = constructor.value.body.body.filter(node => JSON.stringify(clean(node)) === JSON.stringify(clean(indexStatement)));
  assert.equal(added.length, 1, 'Exactly one owner/lease/auth-expiry routing index');
  constructor.value.body.body = constructor.value.body.body.filter(node => !added.includes(node));
  assert.deepEqual(clean(constructor), clean(before.get('constructor')),
    'Every original startup, auth deadline, ownership and economic/payment schema remains exact');

  const fetch = after.get('fetch');
  const queryPaths = ['/_internal/active-zones', '/_internal/zone-world-state'];
  const query = fetch.value.body.body.filter(node => queryPaths.includes(route(node)));
  assert.deepEqual(query.map(route), queryPaths, 'Exactly the reviewed private routing and read-only owner-state queries');
  fetch.value.body.body = fetch.value.body.body.filter(node => !query.includes(node));
  assert.deepEqual(clean(fetch), clean(before.get('fetch')),
    'All original request parsing, session CAS, handoff, bootstrap, economy, payment and upgrade paths remain exact');

  const originalImports = parse(baseline(file)).body.filter(node => node.type === 'ImportDeclaration');
  const activeImports = parse(current(file)).body.filter(node => node.type === 'ImportDeclaration');
  for (const body of [originalImports, activeImports]) {
    const spatial = body.find(node => node.source.value === './spatial.mjs');
    assert.ok(spatial);
    const expected = body === originalImports ? 'allZoneIds' : 'adjacentZoneIds';
    assert.equal(spatial.specifiers.filter(node => node.imported.name === expected).length, 1);
    spatial.specifiers = spatial.specifiers.filter(node => node.imported.name !== expected);
  }
  assert.deepEqual(clean(activeImports), clean(originalImports),
    'Only the all-grid helper is replaced by the validated adjacency helper');
});

test('P5 ZoneRoom preserves authority, economy and transfer code outside exact visibility boundaries', () => {
  const file = 'src/worker/zone-room.mjs';
  const before = methods(baseline(file)), after = methods(current(file));
  assert.deepEqual([...after.keys()].filter(key => !before.has(key)), ['refreshWorldState']);
  assert.deepEqual([...after.keys()].filter(key => key !== 'refreshWorldState'), [...before.keys()],
    'Only one bounded owner-state query helper is added; no original method is removed or reordered');
  const reviewed = new Set(['constructor', 'activePlayer', 'broadcastNearby', 'flushBorderSnapshot',
    'sendInitialGhostSnapshots', 'fetch', 'handleAuth', 'handleMove', 'handleHandoffResume']);
  for (const [key, original] of before) if (!reviewed.has(key))
    assert.deepEqual(clean(after.get(key)), clean(original), `Original ZoneRoom method preserved: ${key}`);

  const constructor = after.get('constructor');
  constructor.value.body.body = remove(constructor.value.body.body, 'this.visibility=new ZoneVisibility(this);',
    'Exactly one zone-local visibility projection is constructed');
  assert.deepEqual(clean(constructor), clean(before.get('constructor')),
    'Every original transport/auth and simulation initializer remains exact');

  const active = after.get('activePlayer');
  const original = before.get('activePlayer');
  const guard = active.value.body.body[0].argument.arguments[0];
  assert.equal(guard.operator, '&&');
  assert.deepEqual(clean(guard.left.left), clean(original.value.body.body[0].argument.arguments[0]));
  assert.deepEqual(clean(guard.left.right), clean(statement('Number(p.exp)>Math.floor(Date.now()/1000);').expression),
    'Visibility strengthens the original predicate with server-clock token expiry');
  assert.deepEqual(clean(guard.right), clean(statement('Number(p.resumeExpiresAt)>Date.now();').expression),
    'Visibility additionally excludes expired server-issued ownership leases without changing their duration');

  const fetch = after.get('fetch');
  const routing = new Set(['/_internal/border-state', '/_internal/border-snapshot']);
  const bounded = body => body.map(node => routing.has(route(node)) ? { reviewedBorderRoute: route(node) } : clean(node));
  assert.deepEqual(bounded(fetch.value.body.body), bounded(before.get('fetch').value.body.body),
    'Internal world-event/revocation and transport admission paths stay exact');

  const auth = after.get('handleAuth');
  const init = statement('p.localVisible=this.nearbySockets(p,ws).map(other=>this.player(other).id);');
  const at = auth.value.body.body.findIndex(node => same(node, init));
  assert.notEqual(at, -1);
  assert.equal(auth.value.body.body.filter(node => same(node, init)).length, 1);
  assert.deepEqual(clean(auth.value.body.body[at+1]), clean(statement('ws.serializeAttachment(p);')));
  auth.value.body.body.splice(at, 2);
  assert.deepEqual(clean(auth), clean(before.get('handleAuth')),
    'Auth adds only an initial local visibility subscription; every verification/session/handoff/welcome statement remains exact');

  const move = after.get('handleMove');
  move.value.body.body = remove(move.value.body.body, 'await this.visibility.refresh(ws);',
    'Exactly one receiver-position-dependent border projection refresh follows actual movement');
  assert.deepEqual(clean(move), clean(before.get('handleMove')),
    'Physics, sequences, anchors, ticket failure handling, movement ACK and cancellation are unchanged');
});

test('P5 adds only active zone-local visibility modules with no ownership or economy writes', () => {
  const oldFiles = execFileSync('git', ['ls-tree', '-r', '--name-only', P4, 'src/worker'],
    { cwd: ROOT, encoding: 'utf8' }).trim().split('\n');
  const graph = moduleGraph();
  const added = graph.filter(item => item.file.startsWith(path.join(ROOT, 'src/worker/')) &&
    !oldFiles.includes(path.relative(ROOT, item.file)));
  assert.deepEqual(added.map(item => path.relative(ROOT, item.file)).sort(),
    ['src/worker/zone-routing.mjs', 'src/worker/zone-visibility.mjs']);
  const allowedTables = new Set(['voxel_border_snapshots', 'voxel_border_revision']);
  for (const module of added) walk(module.ast, node => {
    assert.ok(!(node.type === 'NewExpression' && ['SessionStore', 'EconomyStore'].includes(node.callee.name)),
      'A projection module cannot become a session or economy authority');
    if (node.type !== 'CallExpression' || node.callee.type !== 'MemberExpression' || node.callee.property.name !== 'exec') return;
    const sql = node.arguments[0];
    const source = sql?.type === 'Literal' ? sql.value : sql?.type === 'TemplateLiteral'
      ? sql.quasis.map(part => part.value.cooked).join('') : null;
    assert.equal(typeof source, 'string', 'Every projection SQL statement has an authored table name');
    const tables = source.match(/\bvoxel_\w+/g) || [];
    assert.ok(tables.length, 'Projection SQL identifies an explicit cache/revision table');
    for (const table of tables) assert.ok(allowedTables.has(table), `Only zone-local projection tables are accessible: ${table}`);
  });
});

test('P5 browser changes only the existing COIN_STATE snapshot projection branch', () => {
  const file = 'src/client/secure-socket-handoff.js';
  const before = parse(baseline(file)), after = parse(current(file));
  const cases = [];
  walk(after, node => {
    if (node.type === 'SwitchCase' && node.test?.property?.name === 'COIN_STATE') cases.push(node);
  });
  assert.equal(cases.length, 1);
  const body = cases[0].consequent;
  const expected = statement('if (message.type===protocol.WS_MESSAGE.COIN_STATE && Array.isArray(message.coins)) { secureApplyCoinSnapshot(message.coins,message.serverNow); } else { secureUpdateCoinState(message); }');
  assert.equal(body.length, 2, 'Only one snapshot/single-update branch and the original break');
  assert.deepEqual(clean(body[0]), clean(expected), 'The bounded full snapshot uses the existing authoritative snapshot function');
  assert.equal(body[1].type, 'BreakStatement');
  body[0] = statement('secureUpdateCoinState(message);');
  assert.deepEqual(clean(after), clean(before),
    'Every other client declaration, auth, ownership, handoff and economic packet handler remains exact');
});

test('P5 handoff adds only the validated current-world read and fail-closed refresh before ACK', () => {
  const game = methods(current('src/worker/game-room.mjs'));
  const routes = game.get('fetch').value.body.body;
  const world = routes.find(node => route(node) === '/_internal/zone-world-state');
  assert.deepEqual(clean(world), clean(statement(`
    if (url.pathname==='/_internal/zone-world-state' && request.method==='POST') {
      let body;
      try { body=await request.json(); }
      catch (_) { return Response.json({ok:false,error:'Invalid JSON'},{status:400}); }
      const uid=typeof body?.uid==='string' ? body.uid : '';
      if (!uid || uid.length>128) return Response.json({ok:false,error:'Invalid UID'},{status:400});
      try {
        if (!this.ownsZoneSession(body,uid))
          return Response.json({ok:false,error:'Session no longer owned'},{status:403});
        return Response.json({ok:true,coins:this.coinSnapshot(),luckyBox:this.boxSnapshot(),
          score:this.economy.score(uid),leaderboard:this.top(),serverNow:Date.now()});
      } catch (_) {
        return Response.json({ok:false,error:'World state unavailable'},{status:503});
      }
    }`)), 'The private query validates current owner/generation before reading the existing state, with no mutations');

  const file = 'src/worker/zone-room.mjs';
  const before = methods(baseline(file)), after = methods(current(file));
  const canonical = methods(`export class ZoneRoom {
    async refreshWorldState(p) {
      const response=await this.env.ROOM.getByName('free-v2-demo').fetch(
        new Request('https://internal/_internal/zone-world-state',{
          method:'POST',headers:{'content-type':'application/json'},
          body:JSON.stringify({uid:p.uid,sessionId:p.sessionId,owner:this.sessionOwner()})
        }));
      const state=await response.json();
      if (!response.ok || !state?.ok || !Array.isArray(state.coins) || state.coins.length!==COINS.length ||
          !state.luckyBox || !Number.isSafeInteger(state.score) || state.score<0 || !Array.isArray(state.leaderboard))
        throw Error('World state unavailable');
      return state;
    }
  }`).get('refreshWorldState');
  assert.deepEqual(clean(after.get('refreshWorldState')), clean(canonical),
    'The helper sends only server-owned identity and validates the bounded authoritative response');

  const handoff = after.get('handleHandoffResume');
  let body = handoff.value.body.body;
  body = remove(body, 'let worldState;', 'Exactly one pending owner-state response');
  const transfer = body.find(node => node.type === 'TryStatement');
  assert.ok(transfer);
  const additions = [
    'worldState=await this.refreshWorldState(p);',
    "const stillOwned=await this.sessionCall('validate',{uid:p.uid,sessionId:p.sessionId,owner:this.sessionOwner()});",
    'p=this.player(ws);',
    `if (!stillOwned?.ok || ws.readyState!==1 || p?.revoked || !p?.handoffResume ||
        Date.now()>=Number(p.handoffResume.deadline||0)) {
      await this.sessionCall('release',{uid:p.uid,sessionId:p.sessionId,owner:this.sessionOwner()});
      ws.close(1008,'Handoff ownership rejected'); return;
    }`
  ].map(statement);
  const at = transfer.block.body.findIndex(node => same(node, additions[0]));
  assert.notEqual(at, -1);
  assert.deepEqual(clean(transfer.block.body.slice(at, at+additions.length)), clean(additions),
    'Refresh is immediately fenced by current owner, transport, revocation, provisional state and server expiry');
  assert.deepEqual(clean(transfer.block.body[at-1]), clean(statement('transferred.resumeExpiresAt=checkpoint.resumeExpiresAt;')),
    'Current-world read occurs after the original committed transfer and checkpoint');
  transfer.block.body.splice(at, additions.length);
  transfer.handler.body.body = remove(transfer.handler.body.body, `
    if (transferred?.ok) {
      try { await this.sessionCall('release',{uid:p.uid,sessionId:p.sessionId,owner:this.sessionOwner()}); }
      catch (_) {}
      try { await this.sessionCall('revoke',{uid:p.uid,sessionId:p.sessionId,owner:'zone:'+resume.fromZone}); }
      catch (_) {}
    }`, 'A state-refresh failure attempts only generation-fenced release, then retains original error/close');

  const projections = [
    'this.send(ws,{type:WS_MESSAGE.COIN_STATE,coins:worldState.coins,serverNow:worldState.serverNow});',
    'this.send(ws,{type:WS_MESSAGE.BOX_STATE,box:worldState.luckyBox,serverNow:worldState.serverNow});',
    'this.send(ws,{type:WS_MESSAGE.SCORE,score:worldState.score,serverNow:worldState.serverNow});',
    'this.send(ws,{type:WS_MESSAGE.LEADERBOARD,top:worldState.leaderboard,serverNow:worldState.serverNow});'
  ].map(statement);
  const start = body.findIndex(node => same(node, projections[0]));
  assert.notEqual(start, -1);
  assert.deepEqual(clean(body.slice(start, start+projections.length)), clean(projections));
  const ack = body[start+projections.length];
  assert.equal(ack.expression.arguments[1].properties.find(node => node.key.name === 'type').value.property.name, 'HANDOFF_RESUMED',
    'All four current-state projections precede the original successful target ACK');
  body.splice(start, projections.length);
  handoff.value.body.body = body;
  assert.deepEqual(clean(handoff), clean(before.get('handleHandoffResume')),
    'Every original handoff anchor, CAS, ACK-before-source-close, cancellation and failure guard is retained exactly');
});

test('P5 packet dispatch preserves every guard and receipt while fencing post-checkpoint attachment updates', () => {
  const file = 'src/worker/room-security.mjs';
  const before = parse(baseline(file)), after = parse(current(file));
  const fn = after.body.find(node => node.type === 'FunctionDeclaration' && node.id.name === 'handleFrame');
  assert.ok(fn);
  const completed = fn.body.body.find(node => same(node.test,
    statement('if (economyAction && completed === true && requestKey && player) {}').test));
  assert.ok(completed, 'The original completed-economy replay receipt guard remains exact');
  completed.consequent.body = remove(completed.consequent.body, 'ws.serializeAttachment(player);',
    'Exactly one successful receipt serialization precedes checkpoint waiting');
  fn.body.body = remove(fn.body.body, 'const checkpointUid=player.uid, checkpointSessionId=player.sessionId;',
    'Only the server-owned UID and generation are captured before checkpoint');
  const at = fn.body.body.findIndex(node => node.type === 'VariableDeclaration' && node.declarations[0].id.name === 'checkpoint');
  assert.notEqual(at, -1);
  const refresh = [statement('player=room.player(ws);'), statement(`
    if (ws.readyState!==1 || !player?.uid || player.revoked || player.sessionClosed ||
        player.handoffResume || player.uid!==checkpointUid || player.sessionId!==checkpointSessionId) return;`)
  ];
  assert.deepEqual(clean(fn.body.body.slice(at+1, at+3)), clean(refresh),
    'The current attachment is reread and fenced immediately after checkpoint, before any later serialization');
  fn.body.body.splice(at+1, 2);
  assert.deepEqual(clean(after), clean(before),
    'Every original auth deadline, token/schema/rate/sequence/ownership/replay/queue and error statement remains exact');
});
