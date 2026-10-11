'use strict';
// Browser gameplay stays a classic script: shared lexical globals, overrides,
// HTML handlers and startup order are deliberately preserved.
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const acorn = require('acorn');
const { ROOT, materialize } = require('./source-view.cjs');
const PLACEHOLDER = '<!-- REBUILD_CLIENT_SCRIPT -->';

// Use the authored Worker kernel directly, while preserving the browser's
// classic scope. This assembly contains no independent copy of its physics.
function classicMovementKernel() {
  let source = fs.readFileSync(path.join(ROOT, 'src/shared/movement.mjs'), 'utf8');
  const ast = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
  const exports = [];
  const edits = [];
  for (const node of ast.body) {
    if (node.type === 'ImportDeclaration' || node.type === 'ExportDefaultDeclaration') {
      throw Error('The shared movement kernel must remain a pure named-export module');
    }
    if (node.type !== 'ExportNamedDeclaration') continue;
    if (!node.declaration) throw Error('Movement re-exports cannot be assembled into classic scope');
    const declaration = node.declaration;
    if (declaration.type === 'VariableDeclaration') {
      for (const item of declaration.declarations) {
        if (item.id.type !== 'Identifier') throw Error('Movement exports require simple names');
        exports.push(item.id.name);
      }
    } else if (declaration.id?.name) exports.push(declaration.id.name);
    else throw Error('Unsupported movement export');
    edits.push({ start: node.start, end: declaration.start });
  }
  for (const edit of edits.reverse()) source = source.slice(0, edit.start) + source.slice(edit.end);
  return `const movement = (() => {\n${source}\nreturn { ${exports.join(', ')} };\n})();\n`;
}

async function buildClient() {
  const entry = await import(pathToFileURL(path.join(ROOT, 'src/client/entry.mjs')));
  const roots = { config: entry.config, protocol: entry.protocol, catalog: entry.catalog };
  const source = entry.CLIENT_SOURCES.map(file => {
    const absolute = path.resolve(ROOT, 'src/client', file);
    if (!absolute.startsWith(path.join(ROOT, 'src/client') + path.sep)) throw Error('Invalid client source path');
    return fs.readFileSync(absolute, 'utf8');
  }).join('');
  const script = classicMovementKernel() + materialize(source, roots);
  const template = fs.readFileSync(path.join(ROOT, 'src/client/index.template.html'), 'utf8');
  if (template.split(PLACEHOLDER).length !== 2) throw Error('Client template must have exactly one script placeholder');
  return template.replace(PLACEHOLDER, script);
}
async function main() {
  const html = await buildClient();
  const destination = path.join(ROOT, 'index.html');
  if (process.argv[2] === '--check') {
    if (fs.readFileSync(destination, 'utf8') !== html) throw Error('index.html is stale; run npm run build:client');
    console.log('PASS generated client matches imported shared modules and ordered source');
  } else if (process.argv.length === 2) fs.writeFileSync(destination, html);
  else throw Error('Usage: build-client.cjs [--check]');
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { buildClient, classicMovementKernel };
