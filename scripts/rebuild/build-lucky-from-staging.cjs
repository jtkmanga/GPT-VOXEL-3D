'use strict';
// Assemble the exact Staging gameplay runtime with Lucky Game's existing public
// Firebase/Origin identity. Backend authority comes from the Staging source tree.
// No Slip2Go code, test purchases, or secret values are embedded in the client.
const fs = require('node:fs');
const path = require('node:path');
const acorn = require('acorn');
const { buildClient } = require('./build-client.cjs');

const root = path.resolve(__dirname, '../..');
const origin = 'https://jtkmanga.github.io';
const appCheckSdk = '<script src="https://www.gstatic.com/firebasejs/10.8.0/firebase-app-check-compat.js"></script>';
const authSdk = '<script src="https://www.gstatic.com/firebasejs/10.8.0/firebase-auth-compat.js"></script>';

function sanitizeTokenRequests(source) {
  const ast = acorn.parse(source, { ecmaVersion: 'latest' });
  const edits = [];
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression' &&
        !node.callee.computed && node.callee.property.name === 'getIdToken') {
      edits.push({ start: node.start, end: node.end, text: 'stagingGetIdToken(' +
        source.slice(node.callee.object.start, node.callee.object.end) +
        (node.arguments.length ? ', ' + node.arguments.map(a => source.slice(a.start,a.end)).join(', ') : '') + ')' });
      return;
    }
    for (const v of Object.values(node)) {
      if (Array.isArray(v)) v.forEach(visit);
      else if (v && typeof v === 'object') visit(v);
    }
  }
  visit(ast);
  for (const e of edits.sort((a,b) => b.start-a.start))
    source = source.slice(0,e.start) + e.text + source.slice(e.end);
  return source;
}

async function build() {
  const siteKey = String(process.env.LUCKY_APP_CHECK_SITE_KEY || '');
  if (!/^6L[A-Za-z0-9_-]{30,80}$/.test(siteKey))
    throw Error('Missing or invalid public production App Check site key');
  const runtime = fs.readFileSync(path.join(root,'src/client/staging-runtime.js'),'utf8');
  // Public payment UI by default; LUCKY_SLIP2GO_UI_ENABLED=0 is
  // the emergency client kill-switch. Worker-side PAYMENT_ROLLOUT is authoritative.
  const paymentEnabled = process.env.LUCKY_SLIP2GO_UI_ENABLED !== '0';
  const paymentRollout = process.env.LUCKY_SLIP2GO_ROLLOUT || 'public';
  if (!['public','canary','disabled'].includes(paymentRollout))
    throw Error('Invalid Slip2Go client rollout mode');
  const prependScript =
    'const STAGING_PUBLIC_CONFIG = Object.freeze({authMode:"popup"});\n' +
    'const STAGING_CLIENT_ENABLED = window.location.origin === ' + JSON.stringify(origin) + ';\n' +
    'const LUCKY_SLIP2GO_UI_ENABLED = ' + JSON.stringify(paymentEnabled) + ';\n' +
    'const LUCKY_SLIP2GO_ROLLOUT = ' + JSON.stringify(paymentRollout) + ';\n' +
    'const LUCKY_SLIP2GO_CANARY_OWNER_EMAIL = ' + JSON.stringify('jtkmanga@gmail.com') + ';\n';
  let html = await buildClient({
    prependScript,
    appendScript: runtime,
    transformSource(file,source) {
      if (file === './auth-state.js') {
        const marker = 'firebase.initializeApp(firebaseConfig);';
        if (source.split(marker).length !== 2)
          throw Error('Firebase bootstrap boundary changed');
        source = source.replace(marker,marker + '\n' +
          'firebase.appCheck().activate(new firebase.appCheck.ReCaptchaEnterpriseProvider(' +
          JSON.stringify(siteKey) + '), true);');
      }
      return sanitizeTokenRequests(source);
    }
  });
  if (!html.includes(authSdk)) throw Error('Auth SDK missing');
  if (!html.includes(appCheckSdk)) html = html.replace(authSdk,authSdk + '\n' + appCheckSdk);
  // Do not inject the temporary Staging diagnostics banner on the public game.
  // Staging socket status is optional and never changes gameplay auth.
  if (!paymentEnabled) html=html.replace('ชำระเงินผ่าน PromptPay','ระบบทดลอง · ปิดการชำระเงินจริง');
  if (!html.includes('async function stagingGetAppCheckToken') ||
      !html.includes('STAGING_CLIENT_ENABLED') ||
      !html.includes('SECURE_WORKER_HTTP_BASE'))
    throw Error('Staging runtime assembly is incomplete');
  if (/\b(?:SLIP2GO_API_SECRET|private_key|client_secret|payment_secret|FIREBASE_ADMIN_PRIVATE_KEY)\b/i.test(html))
    throw Error('Privileged server binding referenced in browser asset');
  return html;
}
async function main(){
  const html=await build();
  const dest=path.join(root,'index.html');
  if (process.argv[2]==='--check') {
    if(fs.readFileSync(dest,'utf8')!==html) throw Error('Lucky Staging-derived index.html is stale');
  } else if (process.argv.length===2) fs.writeFileSync(dest,html);
  else throw Error('Usage: build-lucky-from-staging.cjs [--check]');
  console.log('PASS Lucky client built from Staging gameplay; payment UI ' +
    (process.env.LUCKY_SLIP2GO_UI_ENABLED === '0' ? 'disabled' : 'public-ready'));
}
if(require.main===module) main().catch(error=>{console.error(error.message);process.exitCode=1});
module.exports={build,sanitizeTokenRequests};
