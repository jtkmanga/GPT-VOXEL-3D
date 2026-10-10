'use strict';
// Browser gameplay stays a classic script: shared lexical globals, overrides,
// HTML handlers and startup order are deliberately preserved.
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { ROOT, materialize } = require('./source-view.cjs');
const PLACEHOLDER = '<!-- REBUILD_CLIENT_SCRIPT -->';

async function buildClient() {
  const entry = await import(pathToFileURL(path.join(ROOT, 'src/client/entry.mjs')));
  const roots = { config: entry.config, protocol: entry.protocol, catalog: entry.catalog };
  const source = entry.CLIENT_SOURCES.map(file => {
    const absolute = path.resolve(ROOT, 'src/client', file);
    if (!absolute.startsWith(path.join(ROOT, 'src/client') + path.sep)) throw Error('Invalid client source path');
    return fs.readFileSync(absolute, 'utf8');
  }).join('');
  const script = materialize(source, roots);
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
module.exports = { buildClient };
