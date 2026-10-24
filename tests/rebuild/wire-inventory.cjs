'use strict';
// Inspect authored WebSocket sends/broadcasts and packet dispatches, not every
// property called "type". HTTP options and UI/payment state are separate data.
const acorn = require('acorn');
const { walk } = require('../../scripts/rebuild/source-view.cjs');
const EMITTERS = new Set(['send', 'broadcast', 'broadcastAll', 'broadcastNearby', 'sendAllZones', 'sendZoneEvent']);
const FUNCTIONS = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression', 'Program']);

function wireInventory(source, { sourceType = 'script', messages = {} } = {}) {
  const ast = acorn.parse(source, { ecmaVersion: 'latest', sourceType });
  const parents = new Map(), variables = new Map(), references = new Map();
  walk(ast, (node, parent) => { if (parent) parents.set(node, parent); });
  function scope(node) {
    while (node && !FUNCTIONS.has(node.type)) node = parents.get(node);
    return node;
  }
  walk(ast, node => {
    if (node.type !== 'VariableDeclarator' || node.id.type !== 'Identifier' || !node.init) return;
    const owner = scope(node);
    if (!variables.has(owner)) variables.set(owner, new Map());
    const bindings = variables.get(owner);
    bindings.set(node.id.name, [...(bindings.get(node.id.name) || []), node.init]);
  });
  function object(node, seen = new Set()) {
    if (!node || seen.has(node)) return null;
    seen.add(node);
    if (node.type === 'ObjectExpression') return node;
    if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression' &&
        node.callee.object.name === 'JSON' && node.callee.property.name === 'stringify') return object(node.arguments[0], seen);
    if (node.type !== 'Identifier') return null;
    for (let owner = scope(node); owner; owner = scope(parents.get(owner))) {
      const bindings = variables.get(owner)?.get(node.name);
      if (bindings) return bindings.length === 1 ? object(bindings[0], seen) : null;
      if (owner.params?.some(p => p.type === 'Identifier' && p.name === node.name)) return null;
    }
    return null;
  }
  function sharedKey(node) {
    if (node?.type !== 'MemberExpression' || node.computed) return null;
    const owner = node.object;
    const shared = owner.type === 'Identifier' && owner.name === 'WS_MESSAGE' ||
      owner.type === 'MemberExpression' && owner.object.name === 'protocol' && owner.property.name === 'WS_MESSAGE';
    return shared ? node.property.name : null;
  }
  function add(node, role) {
    const key = sharedKey(node);
    const value = key ? messages[key] : node?.type === 'Literal' ? node.value : undefined;
    if (typeof value !== 'string' || !/^[a-z][a-z0-9_]*$/.test(value)) {
      throw Error(`Invalid authored wire discriminator at offset ${node?.start}: ${role}`);
    }
    references.set(node, { value, key, role, start: node.start });
  }
  function packetType(node) {
    if (node?.type === 'ChainExpression') node = node.expression;
    return node?.type === 'MemberExpression' && node.property.name === 'type' &&
      node.object.type === 'Identifier' && ['m', 'message'].includes(node.object.name);
  }
  walk(ast, node => {
    if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression' && EMITTERS.has(node.callee.property.name)) {
      for (const argument of node.arguments) {
        const payload = object(argument);
        const discriminator = payload?.properties.find(p => p.type === 'Property' && (p.key.name ?? p.key.value) === 'type');
        if (discriminator) add(discriminator.value, 'send');
      }
    }
    if (node.type === 'SwitchStatement' && packetType(node.discriminant)) {
      for (const branch of node.cases) if (branch.test) add(branch.test, 'dispatch');
    }
    if (node.type === 'BinaryExpression' && ['===', '!==', '==', '!='].includes(node.operator)) {
      if (packetType(node.left)) add(node.right, 'dispatch');
      else if (packetType(node.right)) add(node.left, 'dispatch');
    }
  });
  return [...references.values()];
}
module.exports = { wireInventory };
