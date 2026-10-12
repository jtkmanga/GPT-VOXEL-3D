'use strict';
const fs = require('node:fs');
const path = require('node:path');
const acorn = require('acorn');
const { pathToFileURL } = require('node:url');
const { ROOT } = require('./source-view.cjs');
const { buildClient } = require('./build-client.cjs');
const { assertIgnoredOutput, assertStagingAssetInventory, validateStagingHtml } = require('./staging-options.cjs');

function replaceInitializers(source, replacements) {
  const ast = acorn.parse(source, { ecmaVersion: 'latest' });
  const edits = [];
  for (const node of ast.body) {
    if (node.type !== 'VariableDeclaration') continue;
    for (const declaration of node.declarations) {
      if (!Object.hasOwn(replacements, declaration.id.name)) continue;
      edits.push({ start: declaration.init.start, end: declaration.init.end, text: replacements[declaration.id.name] });
    }
  }
  if (edits.length !== Object.keys(replacements).length) throw new Error('Staging build could not locate exact configuration declarations');
  for (const edit of edits.sort((a, b) => b.start - a.start)) source = source.slice(0, edit.start) + edit.text + source.slice(edit.end);
  return source;
}

function sanitizeTokenRequests(source) {
  const ast = acorn.parse(source, { ecmaVersion: 'latest' });
  const edits = [];
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression' &&
        !node.callee.computed && node.callee.property.name === 'getIdToken') {
      edits.push({ start: node.start, end: node.end, text: 'stagingGetIdToken(' +
        source.slice(node.callee.object.start, node.callee.object.end) +
        (node.arguments.length ? ', ' + node.arguments.map(argument => source.slice(argument.start, argument.end)).join(', ') : '') + ')' });
      return;
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') visit(value);
    }
  }
  visit(ast);
  for (const edit of edits.sort((a, b) => b.start - a.start)) source = source.slice(0, edit.start) + edit.text + source.slice(edit.end);
  return source;
}

async function buildStagingClient(value, { allowTest = false } = {}) {
  const { validateStagingPublicConfig } = await import(pathToFileURL(path.join(ROOT, 'src/shared/staging.mjs')));
  const config = validateStagingPublicConfig(value, { allowUnconfigured: true, allowTest });
  const serialized = JSON.stringify(config).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
  const prependScript = `const STAGING_PUBLIC_CONFIG = Object.freeze(${serialized});\n` +
    `const STAGING_CLIENT_ENABLED = STAGING_PUBLIC_CONFIG.configured !== false && window.location.origin === STAGING_PUBLIC_CONFIG.workerOrigin;\n`;
  const authInitializer = `(() => {
    if (STAGING_CLIENT_ENABLED) {
      firebase.initializeApp(firebaseConfig);
      return firebase.auth();
    }
    return { currentUser: null, onAuthStateChanged(callback) { queueMicrotask(() => callback(null)); return () => {}; },
      signOut() { return Promise.resolve(); } };
  })()`;
  let html = await buildClient({ prependScript,
    transformSource(file, source) {
      if (file === './auth-state.js') {
        source = replaceInitializers(source, { firebaseConfig: 'STAGING_PUBLIC_CONFIG.firebase || {}',
          auth: authInitializer, database: "({ ref() { throw new Error('Direct Firebase game-data access is disabled in staging'); } })",
          googleProvider: 'STAGING_CLIENT_ENABLED ? new firebase.auth.GoogleAuthProvider() : null' });
        // The replacement auth initializer owns conditional initialization.
        const ast = acorn.parse(source, { ecmaVersion: 'latest' });
        const initializers = ast.body.filter(node => node.type === 'ExpressionStatement' &&
          node.expression.type === 'CallExpression' && node.expression.callee.type === 'MemberExpression' &&
          node.expression.callee.object.name === 'firebase' && node.expression.callee.property.name === 'initializeApp');
        if (initializers.length !== 1) throw new Error('Unexpected Firebase initialization boundary');
        const node = initializers[0]; source = source.slice(0, node.start) + source.slice(node.end);
      }
      if (file === './secure-entitlements-payment.js') source = replaceInitializers(source, {
        SECURE_WORKER_HTTP_BASE: "STAGING_CLIENT_ENABLED ? STAGING_PUBLIC_CONFIG.workerOrigin : ''",
        SECURE_PAYMENT_PROMPTPAY_TARGET: "''"
      });
      return sanitizeTokenRequests(source);
    },
    appendScript: fs.readFileSync(path.join(ROOT, 'src/client/staging-runtime.js'), 'utf8')
  });
  html = html.replace(/(<body[^>]*>)/, '$1\n<div id="staging-status" role="status" style="position:fixed;top:0;left:0;right:0;z-index:10000;background:#5b21b6;color:white;text-align:center;font:12px sans-serif;padding:3px">STAGING · TEST PAYMENTS ONLY</div>');
  html = html.replace('ชำระเงินผ่าน PromptPay', 'Sandbox entitlement fixtures · no payment');
  for (const blocked of ['voxel-run-v2-demo.hjinffv5426.workers.dev', 'lucky-game-6936b',
    'AIzaSyCwn4rJ48I_bsVI2Ez59szQJubShvhO1SE', '0999999999', 'http://localhost', '127.0.0.1']) {
    // The obsolete payment function contains a dummy receiver. Its UI remains disabled;
    // remove the receiver literal from the isolated artifact as well.
    if (blocked === '0999999999') html = html.replaceAll(blocked, '');
    if (html.includes(blocked)) throw new Error('Staging bundle contains a forbidden production/default reference');
  }
  validateStagingHtml(html, { manifest: config });
  return html;
}

async function main(args = process.argv.slice(2)) {
  let publicFile, destination, unconfigured = false, check = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--config') publicFile = args[++index];
    else if (arg === '--out') destination = args[++index];
    else if (arg === '--unconfigured') unconfigured = true;
    else if (arg === '--check') check = true;
    else throw new Error('Usage: build-staging-client.cjs (--config public.json | --unconfigured) --out work/staging/client [--check]');
  }
  if (!destination || Boolean(publicFile) === unconfigured) throw new Error('Choose exactly one public manifest or the disabled unconfigured scaffold');
  const out = assertIgnoredOutput(path.resolve(ROOT, destination), { directory: true });
  const outputFile = assertIgnoredOutput(path.join(out, 'index.html'));
  const existingFile = assertStagingAssetInventory(out, { allowEmpty: !check });
  const value = unconfigured ? { environment: 'staging', configured: false, authMode: 'popup' } : JSON.parse(fs.readFileSync(publicFile, 'utf8'));
  const html = await buildStagingClient(value);
  if (existingFile) validateStagingHtml(fs.readFileSync(existingFile, 'utf8'), { manifest: value });
  if (check) {
    if (fs.readFileSync(outputFile, 'utf8') !== html) throw new Error('Staging generated client is stale');
  } else {
    fs.mkdirSync(out, { recursive: true }); fs.writeFileSync(outputFile, html);
  }
  console.log(`PASS staging client ${check ? 'matches' : 'built'}; ${unconfigured ? 'unconfigured/auth disabled' : 'isolated public configuration'}; no deployment`);
}
if (require.main === module) main().catch(() => { console.error('FAIL staging client build: invalid public configuration or output'); process.exitCode = 1; });
module.exports = { buildStagingClient, main };
