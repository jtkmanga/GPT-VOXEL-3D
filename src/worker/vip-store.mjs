import { SESSION_TTL_MS } from './sessions.mjs';
import { normalizePaymentEvent, validVipUid, VIP_PRODUCT } from './payment-events.mjs';

const generation = value => typeof value === 'string' && value.length > 0 && value.length <= 256;
const denied = (error, status = 409, extra = {}) => ({ ok: false, error, status, ...extra });

// Explicit application policy for the prepared Sandbox adapter. This is NOT a
// claim about a merchant's RPP timezone or end-of-month behavior: activation is
// separately gated on verification of that policy with the Sandbox merchant.
export function sandboxCalendarPeriodEnd(start) {
  if (!Number.isSafeInteger(start) || start < 0) throw Error('Invalid Sandbox calendar period');
  const date = new Date(start);
  if (!Number.isFinite(date.getTime()) || date.getUTCDate() > 28)
    throw Error('Sandbox calendar anchor must be a UTC day from 1 to 28');
  date.setUTCMonth(date.getUTCMonth() + 1);
  if (!Number.isSafeInteger(date.getTime())) throw Error('Invalid Sandbox calendar period');
  return date.getTime();
}

function verifiedSandboxCalendarEvent(raw, now = Date.now(), quotedAmount = VIP_PRODUCT.amount) {
  const keys = ['eventId', 'subscriptionId', 'uid', 'version', 'status', 'product',
    'amount', 'currency', 'periodStart', 'periodEnd'];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) ||
      Object.keys(raw).length !== keys.length || keys.some(key => !Object.hasOwn(raw, key)) ||
      typeof raw.eventId !== 'string' || !/^2c2p:sandbox:[a-f0-9]{64}$/.test(raw.eventId) ||
      typeof raw.subscriptionId !== 'string' || !/^2c2p:sandbox:[A-Za-z0-9]{1,20}$/.test(raw.subscriptionId) ||
      !validVipUid(raw.uid) || raw.version !== 1 || raw.status !== 'active' ||
      raw.product !== VIP_PRODUCT.id || !Number.isSafeInteger(quotedAmount) || quotedAmount < 1 || quotedAmount > 100000 ||
      raw.amount !== quotedAmount || raw.currency !== 'THB' ||
      raw.periodStart > now || raw.periodEnd !== sandboxCalendarPeriodEnd(raw.periodStart) ||
      raw.periodEnd <= now) throw Error('Invalid verified Sandbox calendar event');
  return Object.fromEntries(keys.map(key => [key, raw[key]]));
}

// One instance lives in the trusted logical-server coordinator. Entitlement,
// concurrent capacity and seat generations share its SQLite transaction lock.
export class VipStore {
  constructor(ctx) {
    this.ctx = ctx;
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS voxel_vip_subscriptions (
      uid TEXT PRIMARY KEY, subscription_id TEXT NOT NULL UNIQUE,
      version INTEGER NOT NULL, status TEXT NOT NULL,
      period_start INTEGER NOT NULL, period_end INTEGER NOT NULL,
      fingerprint TEXT NOT NULL, updated_at INTEGER NOT NULL
    )`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS voxel_vip_events (
      event_id TEXT PRIMARY KEY, subscription_id TEXT NOT NULL,
      uid TEXT NOT NULL, version INTEGER NOT NULL, fingerprint TEXT NOT NULL,
      response_json TEXT NOT NULL, created_at INTEGER NOT NULL
    )`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS voxel_vip_seats (
      uid TEXT PRIMARY KEY, session_id TEXT NOT NULL UNIQUE,
      lease_expires INTEGER NOT NULL, exp INTEGER NOT NULL
    )`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS voxel_vip_retired_sessions (
      session_id TEXT PRIMARY KEY, uid TEXT NOT NULL, retired_at INTEGER NOT NULL
    )`);
    this.sql.exec('CREATE INDEX IF NOT EXISTS voxel_vip_seats_exp_idx ON voxel_vip_seats(lease_expires,exp)');
  }

  entitlement(uid, now = Date.now()) {
    const row = this.sql.exec(`SELECT e.vip1_expires,s.status,s.version,s.period_start,s.period_end
      FROM voxel_entitlements e LEFT JOIN voxel_vip_subscriptions s ON s.uid=e.uid
      WHERE e.uid=?`, uid).toArray()[0];
    let expiresAt = Number(row?.vip1_expires) || 0;
    if (row?.status) expiresAt = row.status === 'active' && Number(row.period_start)<=now
      ? Math.min(expiresAt, Number(row.period_end) || 0) : 0;
    return { active: expiresAt > now, expiresAt, version: Number(row?.version) || 0,
      status: row?.status || 'legacy' };
  }

  retire(uid, sessionId, now) {
    this.sql.exec('INSERT OR IGNORE INTO voxel_vip_retired_sessions(session_id,uid,retired_at) VALUES (?,?,?)',
      sessionId, uid, now);
    this.sql.exec('DELETE FROM voxel_vip_seats WHERE uid=? AND session_id=?', uid, sessionId);
  }

  cleanup(now) {
    const invalid = this.sql.exec(`SELECT v.uid,v.session_id FROM voxel_vip_seats v
      LEFT JOIN voxel_entitlements e ON e.uid=v.uid
      LEFT JOIN voxel_vip_subscriptions s ON s.uid=v.uid
      WHERE v.lease_expires<=? OR v.exp<=? OR e.uid IS NULL OR e.vip1_expires<=?
      OR (s.uid IS NOT NULL AND (s.status!='active' OR s.period_start>? OR s.period_end<=?))`,
    now, Math.floor(now / 1000), now, now, now).toArray();
    for (const row of invalid) this.retire(row.uid, row.session_id, now);
  }

  count(now = Date.now()) {
    return this.ctx.storage.transactionSync(() => {
      this.cleanup(now);
      return Number(this.sql.exec('SELECT COUNT(*) AS count FROM voxel_vip_seats').toArray()[0]?.count) || 0;
    });
  }

  applyEvent({ event: input, fingerprint }) {
    let event;
    try { event = normalizePaymentEvent(input); }
    catch (_) { return denied('Invalid provider event', 400); }
    if (typeof fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(fingerprint))
      return denied('Invalid provider event fingerprint', 400);
    return this.#applyNormalizedEvent(event, fingerprint);
  }

  // Only the private verified-invoice adapter calls this method. Browser flags,
  // the generic webhook and client-supplied periods cannot enter this boundary.
  // Legacy applyEvent retains its exact fixed-30-day schema and assertions.
  applyVerifiedSandboxCalendarEvent({ event: input, fingerprint, quotedAmount = VIP_PRODUCT.amount }) {
    let event;
    try { event = verifiedSandboxCalendarEvent(input,Date.now(),quotedAmount); }
    catch (_) { return denied('Invalid verified Sandbox calendar event', 400); }
    if (typeof fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(fingerprint) ||
        event.eventId !== `2c2p:sandbox:${fingerprint}`)
      return denied('Invalid provider event fingerprint', 400);
    return this.#applyNormalizedEvent(event, fingerprint);
  }

  applyVerifiedPromptPayPurchase({ uid, invoiceNo, fingerprint, quotedAmount = VIP_PRODUCT.amount }) {
    if (!validVipUid(uid) || typeof invoiceNo !== 'string' || !/^[A-Za-z0-9]{1,20}$/.test(invoiceNo) ||
        typeof fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(fingerprint) ||
        !Number.isSafeInteger(quotedAmount) || quotedAmount < 1 || quotedAmount > 100000)
      return denied('Invalid verified PromptPay purchase', 400);
    const eventId = `2c2p:promptpay:${fingerprint}`;
    return this.ctx.storage.transactionSync(() => {
      const now = Date.now();
      const receipt = this.sql.exec('SELECT fingerprint,response_json FROM voxel_vip_events WHERE event_id=?',
        eventId).toArray()[0];
      if (receipt) {
        if (receipt.fingerprint !== fingerprint) return denied('PromptPay event ID conflict');
        return { ...JSON.parse(receipt.response_json), replayed: true };
      }
      const previous = this.sql.exec(`SELECT subscription_id,version,status,period_start,period_end
        FROM voxel_vip_subscriptions WHERE uid=?`, uid).toArray()[0];
      if (previous && !String(previous.subscription_id || '').startsWith('2c2p:promptpay:'))
        return denied('Identity already owns another subscription');
      const current = this.entitlement(uid, now);
      const baseExpiry = Math.max(now, Number(current.expiresAt) || 0);
      const subscriptionId = previous?.subscription_id || `2c2p:promptpay:${invoiceNo}`;
      const version = (Number(previous?.version) || 0) + 1;
      const periodStart = previous?.status === 'active' && Number(previous.period_start) <= now &&
        Number(previous.period_end) > now ? Number(previous.period_start) : now;
      const periodEnd = baseExpiry + VIP_PRODUCT.duration;
      this.sql.exec(`INSERT INTO voxel_vip_subscriptions
        (uid,subscription_id,version,status,period_start,period_end,fingerprint,updated_at)
        VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(uid) DO UPDATE SET
        subscription_id=excluded.subscription_id,version=excluded.version,status=excluded.status,
        period_start=excluded.period_start,period_end=excluded.period_end,
        fingerprint=excluded.fingerprint,updated_at=excluded.updated_at`,
      uid, subscriptionId, version, 'active', periodStart, periodEnd, fingerprint, now);
      this.sql.exec(`INSERT INTO voxel_entitlements
        (uid,speed_expires,coin_expires,vip1_expires,updated_at) VALUES (?,0,0,?,?)
        ON CONFLICT(uid) DO UPDATE SET vip1_expires=excluded.vip1_expires,updated_at=excluded.updated_at`,
      uid, periodEnd, now);
      const result = { ok: true, eventId, uid, version, status: 'active',
        expiresAt: periodEnd, replayed: false };
      this.sql.exec(`INSERT INTO voxel_vip_events
        (event_id,subscription_id,uid,version,fingerprint,response_json,created_at) VALUES (?,?,?,?,?,?,?)`,
      eventId, subscriptionId, uid, version, fingerprint, JSON.stringify(result), now);
      return result;
    });
  }

  #applyNormalizedEvent(event, fingerprint) {
    return this.ctx.storage.transactionSync(() => {
      const now = Date.now();
      const receipt = this.sql.exec('SELECT fingerprint,response_json FROM voxel_vip_events WHERE event_id=?',
        event.eventId).toArray()[0];
      if (receipt) {
        if (receipt.fingerprint !== fingerprint) return denied('Provider event ID conflict');
        return { ...JSON.parse(receipt.response_json), replayed: true };
      }
      const owner = this.sql.exec('SELECT uid FROM voxel_vip_subscriptions WHERE subscription_id=?',
        event.subscriptionId).toArray()[0];
      if (owner && owner.uid !== event.uid) return denied('Subscription belongs to another identity');
      const previous = this.sql.exec('SELECT subscription_id,version FROM voxel_vip_subscriptions WHERE uid=?',
        event.uid).toArray()[0];
      // The provider-neutral adapter deliberately binds one subscription to one
      // UID. A provider-specific replacement policy must be explicitly defined.
      if (previous && previous.subscription_id !== event.subscriptionId)
        return denied('Identity already owns another subscription');
      if (previous && Number(previous.version) >= event.version)
        return denied('Stale provider event', 409, { stale: true });
      const previousExpiry=this.entitlement(event.uid,now).expiresAt;
      const expiresAt = event.status === 'active' ? event.periodEnd : 0;
      this.sql.exec(`INSERT INTO voxel_vip_subscriptions
        (uid,subscription_id,version,status,period_start,period_end,fingerprint,updated_at)
        VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(uid) DO UPDATE SET
        version=excluded.version,status=excluded.status,period_start=excluded.period_start,
        period_end=excluded.period_end,fingerprint=excluded.fingerprint,updated_at=excluded.updated_at`,
      event.uid, event.subscriptionId, event.version, event.status,
      event.periodStart, event.periodEnd, fingerprint, now);
      this.sql.exec(`INSERT INTO voxel_entitlements
        (uid,speed_expires,coin_expires,vip1_expires,updated_at) VALUES (?,0,0,?,?)
        ON CONFLICT(uid) DO UPDATE SET vip1_expires=excluded.vip1_expires,updated_at=excluded.updated_at`,
      event.uid, expiresAt, now);
      const revokedSeat = expiresAt <= now || event.periodStart>now || expiresAt<previousExpiry
        ? this.sql.exec('SELECT session_id FROM voxel_vip_seats WHERE uid=?', event.uid).toArray()[0] : null;
      if (revokedSeat) this.retire(event.uid, revokedSeat.session_id, now);
      const result = { ok: true, eventId: event.eventId, uid: event.uid, version: event.version,
        status: event.status, expiresAt, replayed: false,
        ...(revokedSeat ? {revokedSessionId:revokedSeat.session_id} : {}) };
      this.sql.exec(`INSERT INTO voxel_vip_events
        (event_id,subscription_id,uid,version,fingerprint,response_json,created_at) VALUES (?,?,?,?,?,?,?)`,
      event.eventId, event.subscriptionId, event.uid, event.version, fingerprint, JSON.stringify(result), now);
      return result;
    });
  }

  admit({ uid, sessionId, exp, previousSessionId = null }) {
    if (!validVipUid(uid) || !generation(sessionId) || !Number.isSafeInteger(exp) || exp <= 0 ||
        (previousSessionId !== null && !generation(previousSessionId)))
      return denied('Invalid VIP admission', 400);
    return this.ctx.storage.transactionSync(() => {
      const now = Date.now();
      this.cleanup(now);
      const entitlement = this.entitlement(uid, now);
      if (!entitlement.active || exp <= Math.floor(now / 1000))
        return denied('Current VIP entitlement required', 403);
      if (this.sql.exec('SELECT session_id FROM voxel_vip_retired_sessions WHERE session_id=?', sessionId).toArray()[0])
        return denied('VIP session generation retired');
      const existing = this.sql.exec('SELECT * FROM voxel_vip_seats WHERE uid=?', uid).toArray()[0];
      if (existing?.session_id === sessionId) return { ok: true, replayed: true,
        leaseExpiresAt: Number(existing.lease_expires), expiresAt: entitlement.expiresAt };
      if (existing && existing.session_id !== previousSessionId)
        return denied('VIP seat replacement no longer owned');
      const occupied = Number(this.sql.exec('SELECT COUNT(*) AS count FROM voxel_vip_seats').toArray()[0]?.count) || 0;
      if (!existing && occupied >= VIP_PRODUCT.capacity) return denied('VIP server is full', 409, { full: true });
      const duplicateGeneration = this.sql.exec('SELECT uid FROM voxel_vip_seats WHERE session_id=?', sessionId).toArray()[0];
      if (duplicateGeneration && duplicateGeneration.uid !== uid) return denied('VIP session belongs to another identity');
      if (existing) this.retire(uid, existing.session_id, now);
      const leaseExpiresAt = Math.min(now + SESSION_TTL_MS, exp * 1000, entitlement.expiresAt);
      this.sql.exec(`INSERT INTO voxel_vip_seats(uid,session_id,lease_expires,exp) VALUES (?,?,?,?)
        ON CONFLICT(uid) DO UPDATE SET session_id=excluded.session_id,
        lease_expires=excluded.lease_expires,exp=excluded.exp`, uid, sessionId, leaseExpiresAt, exp);
      return { ok: true, replayed: false, leaseExpiresAt, expiresAt: entitlement.expiresAt };
    });
  }

  validate({ uid, sessionId }) {
    if (!validVipUid(uid) || !generation(sessionId)) return denied('Invalid VIP seat identity', 400);
    return this.ctx.storage.transactionSync(() => {
      const now = Date.now();
      this.cleanup(now);
      const seat = this.sql.exec('SELECT * FROM voxel_vip_seats WHERE uid=? AND session_id=?', uid, sessionId).toArray()[0];
      if (!seat) return denied('VIP seat no longer owned', 403);
      const entitlement = this.entitlement(uid, now);
      return { ok: true, leaseExpiresAt: Number(seat.lease_expires), expiresAt: entitlement.expiresAt };
    });
  }

  renew({ uid, sessionId, exp }) {
    if (!validVipUid(uid) || !generation(sessionId) ||
        (exp !== undefined && (!Number.isSafeInteger(exp) || exp <= 0)))
      return denied('Invalid VIP seat renewal', 400);
    return this.ctx.storage.transactionSync(() => {
      const now = Date.now();
      this.cleanup(now);
      const seat = this.sql.exec('SELECT * FROM voxel_vip_seats WHERE uid=? AND session_id=?', uid, sessionId).toArray()[0];
      if (!seat) return denied('VIP seat no longer owned', 403);
      const tokenExpiry = exp === undefined ? Number(seat.exp) : exp;
      if (tokenExpiry <= Math.floor(now / 1000)) return denied('Expired VIP authentication', 403);
      const entitlement = this.entitlement(uid, now);
      const leaseExpiresAt = Math.min(now + SESSION_TTL_MS, tokenExpiry * 1000, entitlement.expiresAt);
      this.sql.exec('UPDATE voxel_vip_seats SET lease_expires=?,exp=? WHERE uid=? AND session_id=?',
        leaseExpiresAt, tokenExpiry, uid, sessionId);
      return { ok: true, leaseExpiresAt, expiresAt: entitlement.expiresAt };
    });
  }

  release({ uid, sessionId }) {
    if (!validVipUid(uid) || !generation(sessionId)) return denied('Invalid VIP seat identity', 400);
    return this.ctx.storage.transactionSync(() => {
      const seat = this.sql.exec('SELECT session_id FROM voxel_vip_seats WHERE uid=? AND session_id=?', uid, sessionId).toArray()[0];
      if (!seat) return denied('VIP seat no longer owned', 403);
      this.retire(uid, sessionId, Date.now());
      return { ok: true };
    });
  }
}
