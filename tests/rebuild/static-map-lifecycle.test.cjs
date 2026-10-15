'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const acorn = require('acorn');
const THREE = require('three');

function fixture() {
  const context = vm.createContext({ THREE, scene: new THREE.Scene(), MAP_SIZE: 1500,
    staticMapObjects: [], nameplateOccluders: [], buildings: [], trees: [] });
  const source = fs.readFileSync('src/client/world.js', 'utf8');
  for (const node of acorn.parse(source, { ecmaVersion: 'latest' }).body) {
    if (node.type === 'FunctionDeclaration' &&
        ['createSeededRandom', 'buildVoxelStructures', 'clearStaticMapObjects'].includes(node.id.name))
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
