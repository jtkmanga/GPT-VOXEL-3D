'use strict';
// A transparent source view for legacy static assertions. Runtime tests use the
// actual bundled module graph; this view never serves as the Worker entrypoint.
const fs = require('node:fs');
const path = require('node:path');
const acorn = require('acorn');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '../..');
function moduleGraph(entry = path.join(ROOT, 'worker.js')) {
  const visited = new Set(), ordered = [];
  function visit(file) {
    file = path.resolve(file);
    if (visited.has(file)) return;
    if (!file.startsWith(ROOT + path.sep)) throw Error('Source graph escaped repository');
    visited.add(file);
    const source = fs.readFileSync(file, 'utf8');
    const ast = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
    for (const node of ast.body) {
      if (!node.source) continue;
      if (!node.source.value.startsWith('.')) throw Error('Only local source imports allowed');
      visit(path.resolve(path.dirname(file), node.source.value));
    }
    ordered.push({ file, source, ast });
  }
  visit(entry);
  return ordered;
}
function edit(source, replacements) {
  for (const { start, end, text } of replacements.sort((a, b) => b.start - a.start)) {
    source = source.slice(0, start) + text + source.slice(end);
  }
  return source;
}
function withoutModuleDeclarations({ source, ast }) {
  const replacements = [];
  for (const node of ast.body) {
    if (node.type === 'ImportDeclaration' || (node.type === 'ExportNamedDeclaration' && !node.declaration)) {
      replacements.push({ start: node.start, end: node.end, text: '' });
    } else if (node.type === 'ExportNamedDeclaration') {
      replacements.push({ start: node.start, end: node.declaration.start, text: '' });
    } else if (node.type === 'ExportDefaultDeclaration') {
      if (node.declaration.type === 'Identifier') replacements.push({ start: node.start, end: node.end, text: '' });
      else replacements.push({ start: node.start, end: node.declaration.start, text: 'const worker = ' });
    }
  }
  return edit(source, replacements);
}
function sharedValues() {
  const files = ['config', 'protocol', 'catalog'];
  const context = vm.createContext({});
  const values = {};
  for (const name of files) {
    const file = path.join(ROOT, `src/shared/${name}.mjs`);
    const source = fs.readFileSync(file, 'utf8');
    const ast = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
    const exports = ast.body.flatMap(n => n.declaration?.declarations?.map(d => d.id.name) || []);
    values[name] = vm.runInContext(`${withoutModuleDeclarations({ source, ast })}\n;({${exports.join(',')}})`, context);
  }
  return values;
}
function walk(node, callback, parent) {
  if (!node || typeof node !== 'object') return;
  if (node.type && callback(node, parent) === false) return;
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach(child => walk(child, callback, node));
    else if (value && typeof value === 'object') walk(value, callback, node);
  }
}
function resolveMember(node, roots) {
  if (node.type === 'Identifier' && Object.hasOwn(roots, node.name)) return { value: roots[node.name] };
  if (node.type !== 'MemberExpression' || node.optional) return null;
  const object = resolveMember(node.object, roots);
  const key = node.computed ? (node.property.type === 'Literal' ? node.property.value : undefined) : node.property.name;
  if (!object || key === undefined || !Object.hasOwn(object.value, key)) return null;
  return { value: object.value[key] };
}
function materialize(source, roots, bareNames = []) {
  const ast = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'script' });
  const replacements = [];
  walk(ast, (node, parent) => {
    const isBare = node.type === 'Identifier' && bareNames.includes(node.name) &&
      !(parent?.type === 'VariableDeclarator' && parent.id === node) &&
      !(parent?.type === 'MemberExpression' && parent.property === node && !parent.computed);
    if (node.type !== 'MemberExpression' && !isBare) return;
    const result = resolveMember(node, roots);
    if (!result) return;
    const json = JSON.stringify(result.value);
    if (json === undefined) throw Error('Shared source value cannot be materialized');
    replacements.push({ start: node.start, end: node.end,
      text: result.value && typeof result.value === 'object' ? `(${json})` : json });
    return false;
  });
  return edit(source, replacements);
}
function workerSourceView(entry) {
  const namespaces = sharedValues();
  const roots = Object.assign({}, ...Object.values(namespaces));
  const bare = ['PAYMENT_CONFIG', 'PAYMENT_PRICES', 'VIP_ENTITLEMENT_CAP', 'LUCKY_BOX_MIN_DISTANCE_FROM_SPAWN'];
  return moduleGraph(entry).map(module => {
    let source = withoutModuleDeclarations(module);
    if (!module.file.includes(`${path.sep}src${path.sep}shared${path.sep}`)) source = materialize(source, roots, bare);
    return `// Source: ${path.relative(ROOT, module.file)}\n${source}`;
  }).join('\n');
}
module.exports = { ROOT, moduleGraph, walk, materialize, sharedValues, workerSourceView };
