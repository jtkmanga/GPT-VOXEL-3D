import { validVipUid } from './payment-events.mjs';
import { sandboxCalendarPeriodEnd } from './vip-store.mjs';

export const TWOC2P_CHECKOUT_TTL_MS = 15 * 60 * 1000;
const denied = (error, status = 409) => ({ ok: false, error, status });
const recordId = (value, maximum = 128) => typeof value === 'string' &&
  value.length > 0 && value.length <= maximum && /^[A-Za-z0-9._:-]+$/.test(value);
const invoiceId = value => typeof value === 'string' && /^[A-Za-z0-9]{1,20}$/.test(value);
const merchantId = value => typeof value === 'string' && /^[A-Za-z0-9]{1,64}$/.test(value);
const fingerprintId = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const integerInstant = value => Number.isSafeInteger(value) && value >= 0;
const categories = new Map([
  ['0000', 'paid'], ['0001', 'pending'], ['2001', 'pending'],
  ['0003', 'cancelled'], ['4080', 'cancelled'], ['2003', 'failed'],
  ['5009', 'expired'], ['5017', 'expired'], ['9020', 'expired']
]);

function providerCivilDate(value) {
  if (typeof value !== 'string' || !/^\d{14}$/.test(value)) return false;
  const parts = [value.slice(0, 4), value.slice(4, 6), value.slice(6, 8),
    value.slice(8, 10), value.slice(10, 12), value.slice(12, 14)].map(Number);
  if (parts[0] < 2000) return false;
  const date = new Date(0);
  date.setUTCFullYear(parts[0], parts[1] - 1, parts[2]);
  date.setUTCHours(parts[3], parts[4], parts[5], 0);
  return date.getUTCFullYear() === parts[0] && date.getUTCMonth() === parts[1] - 1 &&
    date.getUTCDate() === parts[2] && date.getUTCHours() === parts[3] &&
    date.getUTCMinutes() === parts[4] && date.getUTCSeconds() === parts[5];
}

function calendar(now) {
  const periodEnd = sandboxCalendarPeriodEnd(now);
  const date = new Date(now);
  date.setUTCHours(24, 0, 0, 0);
  // An initial checkout cannot cross the UTC date used as its schedule anchor.
  return { periodStart: now, periodEnd,
    expiresAt: Math.min(now + TWOC2P_CHECKOUT_TTL_MS, date.getTime()) };
}

function normalizedNotification(raw) {
  const required = ['merchantID', 'invoiceNo', 'amount', 'currencyCode',
    'paymentID', 'referenceNo', 'respCode', 'transactionDateTime'];
  const optional = ['recurringUniqueID', 'recurringSequenceNo', 'tranRef'];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) ||
      required.some(key => !Object.hasOwn(raw, key)) ||
      Object.keys(raw).some(key => !required.includes(key) && !optional.includes(key)) ||
      !merchantId(raw.merchantID) || !invoiceId(raw.invoiceNo) || raw.amount !== 50 ||
      raw.currencyCode !== 'THB' || !recordId(raw.paymentID, 255) || !recordId(raw.referenceNo, 50) ||
      typeof raw.respCode !== 'string' || !/^\d{4}$/.test(raw.respCode) ||
      !providerCivilDate(raw.transactionDateTime) ||
      (raw.respCode === '0000' && !Object.hasOwn(raw, 'recurringUniqueID')) ||
      (Object.hasOwn(raw, 'recurringUniqueID') &&
        !(typeof raw.recurringUniqueID === 'string' && /^\d{1,20}$/.test(raw.recurringUniqueID))) ||
      (Object.hasOwn(raw, 'recurringSequenceNo') &&
        !(typeof raw.recurringSequenceNo === 'string' && /^\d{1,10}$/.test(raw.recurringSequenceNo))) ||
      (Object.hasOwn(raw, 'tranRef') && !recordId(raw.tranRef, 255))) return null;
  return Object.fromEntries([...required, ...optional].filter(key => Object.hasOwn(raw, key))
    .map(key => [key, raw[key]]));
}

function invoiceNumber(prefix) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const random = crypto.getRandomValues(new Uint8Array(20 - prefix.length));
  // Rejection sampling keeps each character uniformly distributed.
  for (let index = 0; index < random.length; index++) {
    while (random[index] >= 252) random[index] = crypto.getRandomValues(new Uint8Array(1))[0];
  }
  return prefix + Array.from(random, value => alphabet[value % alphabet.length]).join('');
}

function safeCheckout(row) {
  return { ok: true, invoiceNo: row.invoice_no, merchantID: row.merchant_id,
    invoicePrefix: row.invoice_prefix,
    amount: Number(row.amount), currencyCode: row.currency_code, status: row.status,
    createdAt: Number(row.created_at), expiresAt: Number(row.expires_at),
    periodStart: Number(row.period_start), periodEnd: Number(row.period_end),
    tokenState: row.token_state };
}

// The staging entitlement coordinator owns this ledger. No provider token,
// Hosted Payment Page URL, card details or signing credential is stored here.
// Creation receives ONLY the Firebase UID verified by the private HTTP adapter.
export class Twoc2pSandboxStore {
  constructor(ctx, vip) {
    this.ctx = ctx;
    this.sql = ctx.storage.sql;
    this.vip = vip;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS voxel_2c2p_sandbox_checkouts (
      invoice_no TEXT PRIMARY KEY, uid TEXT NOT NULL, request_id TEXT NOT NULL,
      merchant_id TEXT NOT NULL, invoice_prefix TEXT NOT NULL,
      amount INTEGER NOT NULL CHECK(amount=50),
      currency_code TEXT NOT NULL CHECK(currency_code='THB'), status TEXT NOT NULL,
      token_state TEXT NOT NULL DEFAULT 'unrequested', created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL, period_start INTEGER NOT NULL, period_end INTEGER NOT NULL,
      payment_id TEXT UNIQUE, reference_no TEXT, recurring_unique_id TEXT,
      recurring_sequence_no TEXT, tran_ref TEXT, transaction_date_time TEXT,
      UNIQUE(uid,request_id)
    )`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS voxel_2c2p_sandbox_uid_idx
      ON voxel_2c2p_sandbox_checkouts(uid,status,expires_at)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS voxel_2c2p_sandbox_notifications (
      fingerprint TEXT PRIMARY KEY, invoice_no TEXT NOT NULL,
      payment_id TEXT NOT NULL, resp_code TEXT NOT NULL,
      notification_json TEXT NOT NULL, response_json TEXT NOT NULL, created_at INTEGER NOT NULL
    )`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS voxel_2c2p_sandbox_transactions (
      payment_id TEXT PRIMARY KEY, reference_no TEXT NOT NULL UNIQUE,
      invoice_no TEXT NOT NULL, created_at INTEGER NOT NULL
    )`);
  }

  expire(now) {
    this.sql.exec(`UPDATE voxel_2c2p_sandbox_checkouts SET status='expired'
      WHERE status='pending' AND expires_at<=?`, now);
  }

  createCheckout(input, now = Date.now()) {
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        Object.keys(input).length !== 4 ||
        !['uid', 'merchantID', 'invoicePrefix', 'requestId'].every(key => Object.hasOwn(input, key)) ||
        !validVipUid(input.uid) || !merchantId(input.merchantID) || !recordId(input.requestId) ||
        typeof input.invoicePrefix !== 'string' || !/^[A-Za-z0-9]{1,15}$/.test(input.invoicePrefix) ||
        !integerInstant(now)) return denied('Invalid Sandbox checkout request', 400);
    return this.ctx.storage.transactionSync(() => {
      this.expire(now);
      const previous = this.sql.exec(`SELECT * FROM voxel_2c2p_sandbox_checkouts
        WHERE uid=? AND request_id=?`, input.uid, input.requestId).toArray()[0];
      if (previous) {
        if (previous.merchant_id !== input.merchantID)
          return denied('Checkout request identity conflict');
        return { ...safeCheckout(previous), replayed: true };
      }
      // Subscription replacement and recurring renewal remain blocked until
      // documented merchant lifecycle semantics have their own verified path.
      if (this.sql.exec('SELECT uid FROM voxel_vip_subscriptions WHERE uid=?', input.uid).toArray()[0])
        return denied('Sandbox subscription lifecycle is not enabled');
      if (this.sql.exec(`SELECT invoice_no FROM voxel_2c2p_sandbox_checkouts
        WHERE uid=? AND status='pending' AND expires_at>?`, input.uid, now).toArray()[0])
        return denied('A Sandbox checkout is already pending');
      let period;
      try { period = calendar(now); }
      catch (_) { return denied('Sandbox monthly scheduling requires a verified UTC day 1-28 anchor', 503); }
      for (let attempt = 0; attempt < 16; attempt++) {
        const invoiceNo = invoiceNumber(input.invoicePrefix);
        if (this.sql.exec('SELECT invoice_no FROM voxel_2c2p_sandbox_checkouts WHERE invoice_no=?', invoiceNo)
          .toArray()[0]) continue;
        this.sql.exec(`INSERT INTO voxel_2c2p_sandbox_checkouts
          (invoice_no,uid,request_id,merchant_id,invoice_prefix,amount,currency_code,status,
          created_at,expires_at,period_start,period_end)
          VALUES (?,?,?,?,?,50,'THB','pending',?,?,?,?)`, invoiceNo, input.uid, input.requestId,
        input.merchantID, input.invoicePrefix, now, period.expiresAt, period.periodStart, period.periodEnd);
        return { ...safeCheckout(this.row(invoiceNo)), replayed: false };
      }
      return denied('Sandbox invoice allocation unavailable', 503);
    });
  }

  row(invoiceNo) {
    return this.sql.exec('SELECT * FROM voxel_2c2p_sandbox_checkouts WHERE invoice_no=?', invoiceNo)
      .toArray()[0];
  }

  checkout(invoiceNo, now = Date.now()) {
    if (!invoiceId(invoiceNo) || !integerInstant(now)) return denied('Invalid Sandbox invoice', 400);
    return this.ctx.storage.transactionSync(() => {
      this.expire(now);
      const row = this.row(invoiceNo);
      return row ? { ...safeCheckout(row), uid: row.uid,
        ...(row.payment_id ? { paymentID: row.payment_id, referenceNo: row.reference_no } : {}) }
        : denied('Sandbox checkout not found', 404);
    });
  }

  claimTokenAttempt({ invoiceNo, uid }, now = Date.now()) {
    if (!invoiceId(invoiceNo) || !validVipUid(uid) || !integerInstant(now))
      return denied('Invalid Sandbox token attempt', 400);
    return this.ctx.storage.transactionSync(() => {
      this.expire(now);
      const row = this.row(invoiceNo);
      if (!row || row.uid !== uid) return denied('Sandbox checkout not found', 404);
      if (row.status !== 'pending' || row.token_state !== 'unrequested')
        return denied('Sandbox payment token attempt is already fenced');
      this.sql.exec(`UPDATE voxel_2c2p_sandbox_checkouts SET token_state='requesting' WHERE invoice_no=?`, invoiceNo);
      return safeCheckout(this.row(invoiceNo));
    });
  }

  finishTokenAttempt({ invoiceNo, uid, succeeded }, now = Date.now()) {
    if (!invoiceId(invoiceNo) || !validVipUid(uid) || typeof succeeded !== 'boolean' || !integerInstant(now))
      return denied('Invalid Sandbox token outcome', 400);
    return this.ctx.storage.transactionSync(() => {
      this.expire(now);
      const row = this.row(invoiceNo);
      if (!row || row.uid !== uid) return denied('Sandbox checkout not found', 404);
      const state = succeeded ? 'ready' : 'failed';
      if (row.token_state === state) return { ...safeCheckout(row), replayed: true };
      if (row.token_state !== 'requesting') return denied('Sandbox token outcome is not owned');
      if (!['pending', 'paid'].includes(row.status))
        return denied('Sandbox checkout is no longer payable');
      this.sql.exec('UPDATE voxel_2c2p_sandbox_checkouts SET token_state=? WHERE invoice_no=?', state, invoiceNo);
      return { ...safeCheckout(this.row(invoiceNo)), replayed: false };
    });
  }

  applyNotification({ notification: input, fingerprint }, now = Date.now()) {
    const notification = normalizedNotification(input);
    if (!notification || !fingerprintId(fingerprint) || !integerInstant(now))
      return denied('Invalid verified Sandbox notification', 400);
    return this.ctx.storage.transactionSync(() => {
      const receipt = this.sql.exec(`SELECT notification_json,response_json
        FROM voxel_2c2p_sandbox_notifications WHERE fingerprint=?`, fingerprint).toArray()[0];
      if (receipt) {
        if (receipt.notification_json !== JSON.stringify(notification))
          return denied('Sandbox notification fingerprint conflict');
        return { ...JSON.parse(receipt.response_json), entitlementGranted: false, replayed: true };
      }
      this.expire(now);
      const row = this.row(notification.invoiceNo);
      if (!row) return denied('Sandbox checkout not found', 404);
      if (row.merchant_id !== notification.merchantID || Number(row.amount) !== notification.amount ||
          row.currency_code !== notification.currencyCode)
        return denied('Sandbox payment does not match its checkout', 400);
      const transaction = this.sql.exec(`SELECT invoice_no,payment_id,reference_no
        FROM voxel_2c2p_sandbox_transactions WHERE payment_id=? OR reference_no=?`,
      notification.paymentID, notification.referenceNo).toArray()[0];
      if (transaction && (transaction.invoice_no !== row.invoice_no ||
          transaction.payment_id !== notification.paymentID || transaction.reference_no !== notification.referenceNo))
        return denied('Sandbox transaction belongs to another invoice');
      const category = categories.get(notification.respCode) || 'unconfirmed';
      let result;
      if (row.status === 'paid') {
        if (category === 'paid' && (row.payment_id !== notification.paymentID ||
            row.reference_no !== notification.referenceNo)) return denied('Sandbox invoice already paid by another transaction');
        // A re-signed/redelivered receipt may not substitute the recurring plan,
        // transaction reference or transaction timestamp of the accepted charge.
        if (category === 'paid' && [
          ['recurring_unique_id', 'recurringUniqueID'], ['recurring_sequence_no', 'recurringSequenceNo'],
          ['tran_ref', 'tranRef'], ['transaction_date_time', 'transactionDateTime']
        ].some(([column, field]) => (row[column] ?? null) !== (notification[field] ?? null)))
          return denied('Sandbox paid transaction metadata conflict');
        result = { ok: true, invoiceNo: row.invoice_no, status: 'paid',
          entitlementGranted: false, replayed: true, ignored: category !== 'paid' };
      } else if (row.status !== 'pending') {
        if (category === 'paid') return denied('Sandbox checkout is no longer payable');
        result = { ok: true, invoiceNo: row.invoice_no, status: row.status,
          entitlementGranted: false, replayed: false };
      } else if (category === 'paid') {
        // The callback may race the signed token response, so requesting is
        // accepted. An uninitiated or ambiguously failed request is held for a
        // future authenticated reconciliation path instead of granting access.
        if (!['requesting', 'ready'].includes(row.token_state))
          return denied('Sandbox payment token attempt is not confirmed');
        const event = { eventId: `2c2p:sandbox:${fingerprint}`,
          subscriptionId: `2c2p:sandbox:${row.invoice_no}`, uid: row.uid,
          version: 1, status: 'active', product: 'vip1', amount: 50, currency: 'THB',
          periodStart: Number(row.period_start), periodEnd: Number(row.period_end) };
        const applied = this.vip.applyVerifiedSandboxCalendarEvent({ event, fingerprint });
        if (!applied.ok) return applied;
        this.sql.exec(`UPDATE voxel_2c2p_sandbox_checkouts SET status='paid',payment_id=?,reference_no=?,
          recurring_unique_id=?,recurring_sequence_no=?,tran_ref=?,transaction_date_time=? WHERE invoice_no=?`,
        notification.paymentID, notification.referenceNo, notification.recurringUniqueID ?? null,
        notification.recurringSequenceNo ?? null, notification.tranRef ?? null,
        notification.transactionDateTime, row.invoice_no);
        result = { ok: true, invoiceNo: row.invoice_no, status: 'paid',
          entitlementGranted: true, expiresAt: event.periodEnd, replayed: false };
      } else {
        if (['failed', 'cancelled', 'expired'].includes(category))
          this.sql.exec('UPDATE voxel_2c2p_sandbox_checkouts SET status=? WHERE invoice_no=?', category, row.invoice_no);
        result = { ok: true, invoiceNo: row.invoice_no, status: category,
          entitlementGranted: false, replayed: false };
      }
      this.sql.exec(`INSERT OR IGNORE INTO voxel_2c2p_sandbox_transactions
        (payment_id,reference_no,invoice_no,created_at) VALUES (?,?,?,?)`,
      notification.paymentID, notification.referenceNo, row.invoice_no, now);
      this.sql.exec(`INSERT INTO voxel_2c2p_sandbox_notifications
        (fingerprint,invoice_no,payment_id,resp_code,notification_json,response_json,created_at) VALUES (?,?,?,?,?,?,?)`,
      fingerprint, row.invoice_no, notification.paymentID, notification.respCode,
      JSON.stringify(notification), JSON.stringify(result), now);
      return result;
    });
  }
}
