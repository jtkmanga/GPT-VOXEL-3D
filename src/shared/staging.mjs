// Public staging configuration only. Server credentials never belong in this schema.
export const STAGING_UNCONFIGURED = Object.freeze({ environment: 'staging', configured: false, authMode: 'popup' });

function record(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null ||
      Object.keys(value).some(key => !keys.includes(key))) throw new Error(`Invalid ${label} fields`);
}
function text(value, expression, label) {
  if (typeof value !== 'string' || !expression.test(value)) throw new Error(`Invalid ${label}`);
  return value;
}

export function validateStagingPublicConfig(value, { allowUnconfigured = false, allowTest = false } = {}) {
  if (allowUnconfigured && value?.configured === false) {
    record(value, ['environment', 'configured', 'authMode'], 'unconfigured staging');
    if (value.environment !== 'staging' || value.authMode !== 'popup') throw new Error('Invalid unconfigured staging');
    return STAGING_UNCONFIGURED;
  }
  record(value, ['environment', 'workerName', 'workerOrigin', 'firebase', 'authMode'], 'public staging');
  if (value.environment !== 'staging') throw new Error('Staging environment is required');
  const workerName = text(value.workerName, /^gpt-voxel-3d-staging-[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/, 'staging Worker name');
  const parsed = typeof value.workerOrigin === 'string' ? new URL(value.workerOrigin) : null;
  if (!parsed || parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port ||
      parsed.origin !== value.workerOrigin || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error('Staging Worker must use an explicit HTTPS origin');
  }
  const host = parsed.hostname;
  const safeWorkersHost = host.startsWith(`${workerName}.`) &&
    /^[a-z0-9-]+\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.workers\.dev$/.test(host);
  const testHost = allowTest && host === `${workerName}.invalid`;
  if (!safeWorkersHost && !testHost) throw new Error('Staging Worker origin must match its isolated Worker name');
  record(value.firebase, ['apiKey', 'authDomain', 'projectId', 'appId', 'messagingSenderId'], 'public Firebase');
  const projectId = text(value.firebase.projectId, /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/, 'Firebase project ID');
  if (!projectId.includes('staging')) throw new Error('Firebase project ID must explicitly identify staging');
  if (value.firebase.authDomain !== `${projectId}.firebaseapp.com`) throw new Error('Firebase auth domain must match the staging project');
  const apiKey = text(value.firebase.apiKey, allowTest ? /^(?:AIza[A-Za-z0-9_-]{35}|synthetic-public-staging-key)$/ : /^AIza[A-Za-z0-9_-]{35}$/, 'public Firebase API key');
  const appId = text(value.firebase.appId, /^1:[0-9]+:web:[a-f0-9]{8,64}$/, 'public Firebase app ID');
  if (apiKey === 'AIzaSyCwn4rJ48I_bsVI2Ez59szQJubShvhO1SE' ||
      appId.startsWith('1:541211602508:') || value.firebase.messagingSenderId === '541211602508') {
    throw new Error('Known production Firebase public configuration cannot be reused for staging');
  }
  const firebase = { apiKey, authDomain: value.firebase.authDomain, projectId, appId };
  if (value.firebase.messagingSenderId !== undefined) {
    firebase.messagingSenderId = text(value.firebase.messagingSenderId, /^[0-9]{1,24}$/, 'Firebase messaging sender ID');
    if (firebase.messagingSenderId !== appId.split(':')[1]) throw new Error('Firebase public app and sender must identify the same staging project');
  }
  if (value.authMode !== 'popup' && value.authMode !== 'redirect') throw new Error('Google auth mode must be popup or redirect');
  return Object.freeze({ environment: 'staging', workerName, workerOrigin: parsed.origin,
    firebase: Object.freeze(firebase), authMode: value.authMode });
}
