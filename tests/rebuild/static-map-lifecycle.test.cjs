'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const acorn = require('acorn');
const THREE = require('three');

function fixture() {
  const context = vm.createContext({ THREE, scene: new THREE.Scene(), MAP_SIZE: 1500,
    staticMapObjects: [], nameplateOccluders: [], buildings: [], trees: [], coins: [], MAX_COINS_PER_MAP: 200 });
  const source = fs.readFileSync('src/client/world.js', 'utf8');
  for (const node of acorn.parse(source, { ecmaVersion: 'latest' }).body) {
    if (node.type === 'FunctionDeclaration' &&
        ['createSeededRandom', 'buildVoxelStructures', 'clearStaticMapObjects', 'clearCoinMeshes', 'spawnCoins', 'rebuildServerStaticMap'].includes(node.id.name))
      vm.runInContext(source.slice(node.start, node.end), context);
  }
  return context;
}
function watch(resource) {
  let count = 0;
  resource.addEventListener('dispose', () => count++);
  return () => count;
}

test('D009 generated static maps release each unique resource once over repeated rebuilds', () => {
  const f = fixture();
  const ground = new THREE.Mesh(new THREE.BoxGeometry(1500, 2, 1500), new THREE.MeshBasicMaterial());
  const groundGeometryDisposals = watch(ground.geometry), groundMaterialDisposals = watch(ground.material);
  f.scene.add(ground);
  for (const seed of ['map-a', 'map-b', 'map-a']) {
    f.mapRandom = f.createSeededRandom(seed); f.buildVoxelStructures();
    const objects = [...f.staticMapObjects];
    assert.ok(objects.length > 500);
    const resources = new Set(objects.flatMap(object => [object.geometry, object.material]));
    const counts = [...resources].map(watch);
    f.nameplateOccluders.push(...objects.slice(0, 3));
    f.clearStaticMapObjects();
    assert.ok(counts.every(count => count() === 1), 'all removed resources must be disposed once');
    assert.deepEqual(f.scene.children, [ground]);
    for (const key of ['staticMapObjects', 'nameplateOccluders', 'buildings', 'trees']) assert.equal(f[key].length, 0);
    assert.ok(objects.every(object => object.parent === null));
    f.clearStaticMapObjects();
    assert.ok(counts.every(count => count() === 1), 'empty cleanup must not dispose twice');
  }
  assert.equal(groundGeometryDisposals(), 0); assert.equal(groundMaterialDisposals(), 0);
  ground.geometry.dispose(); ground.material.dispose();
});

test('D009 cleanup preserves resources shared with retained scene descendants and handles material arrays', () => {
  const f = fixture();
  const geometry = new THREE.BoxGeometry(2, 2, 2);
  const shared = new THREE.MeshBasicMaterial(), owned = new THREE.MeshBasicMaterial();
  const counts = [watch(geometry), watch(shared), watch(owned)];
  const removed = new THREE.Mesh(geometry, [shared, owned, owned]);
  const retained = new THREE.Mesh(geometry, shared), group = new THREE.Group();
  group.add(retained); f.scene.add(group, removed);
  f.staticMapObjects.push(removed, removed);
  f.clearStaticMapObjects();
  assert.deepEqual(counts.map(count => count()), [0, 0, 1]);
  assert.equal(retained.parent, group); assert.equal(removed.parent, null);
  f.clearStaticMapObjects();
  assert.deepEqual(counts.map(count => count()), [0, 0, 1]);
  geometry.dispose(); shared.dispose();
});


test('D010 map rebuild disposes the old shared coin resources once and preserves new coins', () => {
  const f = fixture();
  f.rebuildServerStaticMap('coin-a');
  for (const seed of ['coin-b', 'coin-a', 'coin-c']) {
    const old = f.coins.map(coin => coin.mesh);
    assert.equal(old.length, 200);
    assert.equal(new Set(old.map(mesh => mesh.geometry)).size, 1);
    assert.equal(new Set(old.map(mesh => mesh.material)).size, 1);
    const geometryDisposed = watch(old[0].geometry), materialDisposed = watch(old[0].material);
    f.rebuildServerStaticMap(seed);
    assert.equal(geometryDisposed(), 1); assert.equal(materialDisposed(), 1);
    assert.ok(old.every(mesh => mesh.parent === null));
    assert.equal(f.coins.length, 200);
    assert.equal(new Set(f.coins.map(coin => coin.id)).size, 200);
    assert.ok(f.coins.every(coin => coin.mesh.parent === f.scene && !old.includes(coin.mesh)));
  }
  f.clearStaticMapObjects(); f.clearCoinMeshes(); f.clearCoinMeshes();
  assert.equal(f.scene.children.length, 0); assert.equal(f.coins.length, 0);
});

test('D010 authoritative snapshots reuse coin resources; cleanup respects retained shared owners', () => {
  const f = fixture(); f.mapRandom = () => .5; f.spawnCoins(200);
  const meshes = f.coins.map(coin => coin.mesh);
  const geometryDisposed = watch(meshes[0].geometry), materialDisposed = watch(meshes[0].material);
  const retained = new THREE.Mesh(meshes[0].geometry, meshes[0].material);
  f.scene.add(retained);
  f.secureNow = () => 1000; f.secureSetServerNow = () => {};
  const source = fs.readFileSync('src/client/secure-snapshots.js', 'utf8');
  const node = acorn.parse(source, { ecmaVersion: 'latest' }).body.find(node =>
    node.type === 'FunctionDeclaration' && node.id.name === 'secureApplyCoinSnapshot');
  vm.runInContext(source.slice(node.start, node.end), f);
  f.secureApplyCoinSnapshot([{ id: 0, cycle: 1, x: 20, z: 30, respawnAt: 2000 }]);
  assert.equal(f.coins[0].active, false);
  assert.equal(f.coins[0].mesh.position.x, 20);
  f.secureApplyCoinSnapshot([{ id: 0, cycle: 2, x: 40, z: 50, respawnAt: 0 }]);
  assert.equal(f.coins[0].active, true);
  assert.equal(f.coins[0].mesh.position.x, 40);
  assert.ok(f.coins.every((coin, i) => coin.mesh === meshes[i]));
  assert.equal(geometryDisposed(), 0); assert.equal(materialDisposed(), 0);
  f.clearCoinMeshes();
  assert.equal(geometryDisposed(), 0); assert.equal(materialDisposed(), 0);
  assert.deepEqual(f.scene.children, [retained]);
  retained.geometry.dispose(); retained.material.dispose();
});

function chestFixture() {
  const f = fixture();
  f.luckyBox = null;
  f.document = { getElementById: () => ({ classList: { add() {}, remove() {} } }) };
  const world = fs.readFileSync('src/client/world.js', 'utf8');
  const chest = acorn.parse(world, { ecmaVersion: 'latest' }).body.find(n => n.id?.name === 'createTreasureChest');
  vm.runInContext(world.slice(chest.start, chest.end), f);
  const secure = fs.readFileSync('src/client/secure-menu-economy.js', 'utf8');
  for (const n of acorn.parse(secure, { ecmaVersion: 'latest' }).body) {
    if (['clearLuckyBoxMesh', 'secureReturnToMenu'].includes(n.id?.name) ||
      n.expression?.left?.name === 'spawnLuckyBoxes') vm.runInContext(secure.slice(n.start, n.end), f);
  }
  Object.assign(f, { state: {}, secureHandoffResumeTimer: null, secureClearRemoteState() {} });
  return f;
}
function chestResources(mesh) {
  const resources = new Set();
  mesh.traverse(o => { if (o.geometry) resources.add(o.geometry);
    for (const m of (Array.isArray(o.material) ? o.material : [o.material])) if (m) resources.add(m); });
  return [...resources];
}
test('D011 chest replacement and menu return release nested resources exactly once', () => {
  const f = chestFixture(); f.spawnLuckyBoxes();
  for (let i = 0; i < 3; i++) {
    const old = f.luckyBox.mesh, counts = chestResources(old).map(watch);
    assert.ok(counts.length > 3);
    f.spawnLuckyBoxes();
    assert.ok(counts.every(count => count() === 1));
    assert.equal(old.parent, null); assert.equal(f.scene.children.length, 1);
    assert.equal(f.luckyBox.active, false); assert.equal(f.luckyBox.mesh.visible, false);
  }
  const counts = chestResources(f.luckyBox.mesh).map(watch);
  f.secureReturnToMenu(); f.secureReturnToMenu();
  assert.ok(counts.every(count => count() === 1));
  assert.equal(f.luckyBox, null); assert.equal(f.scene.children.length, 0);
});
test('D011 retained scene owners protect shared chest geometry and material', () => {
  const f = chestFixture(); f.spawnLuckyBoxes();
  const piece = f.luckyBox.mesh.children[0];
  const retained = new THREE.Mesh(piece.geometry, piece.material);
  f.scene.add(retained);
  const counts = [watch(piece.geometry), watch(piece.material)];
  f.secureReturnToMenu();
  assert.deepEqual(counts.map(count => count()), [0, 0]);
  assert.deepEqual(f.scene.children, [retained]);
  retained.geometry.dispose(); retained.material.dispose();
});
