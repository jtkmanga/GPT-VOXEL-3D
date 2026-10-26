import { validVipUid, VIP_PRODUCT } from './payment-events.mjs';

export const PROMPTPAY_CHECKOUT_TTL_MS = 15 * 60 * 1000;
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

function invoiceNumber() {
  const prefix = 'VQP';
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const random = crypto.getRandomValues(new Uint8Array(20 - prefix.length));
  for (let index = 0; index < random.length; index++) {
    while (random[index] >= 252) random[index] = crypto.getRandomValues(new Uint8Array(1))[0];
  }
  return prefix + Array.from(random, value => alphabet[value % alphabet.length]).join('');
}

function safeCheckout(row, includeQr = false) {
  return { ok: true, invoiceNo: row.invoice_no, merchantID: row.merchant_id,
    amount: Number(row.quoted_amount), currencyCode: row.currency_code, status: row.status,
    createdAt: Number(row.created_at), expiresAt: Number(row.expires_at),
    providerState: row.provider_state,
    ...(includeQr && typeof row.qr_url === 'string' && row.qr_url ? { qrImageUrl: row.qr_url } : {}) };
}

export class Twoc2pPromptPayStore {
  constructor(ctx, vip) {
    this.ctx = ctx;
    this.sql = ctx.storage.sql;
    this.vip = vip;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS voxel_2c2p_promptpay_checkouts (
      invoice_no TEXT PRIMARY KEY, uid TEXT NOT NULL, request_id TEXT NOT NULL,
      merchant_id TEXT NOT NULL, quoted_amount INTEGER NOT NULL CHECK(quoted_amount>=1 AND quoted_amount<=100000),
      currency_code TEXT NOT NULL CHECK(currency_code='THB'), status TEXT NOT NULL,
      provider_state TEXT NOT NULL DEFAULT 'unrequested', qr_url TEXT,
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
      transaction_id TEXT UNIQUE, reference_no TEXT UNIQUE, transaction_date_time TEXT,
      UNIQUE(uid,request_id)
    )`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS voxel_2c2p_promptpay_uid_idx
      ON voxel_2c2p_promptpay_checkouts(uid,status,expires_at)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS voxel_2c2p_promptpay_notifications (
      fingerprint TEXT PRIMARY KEY, invoice_no TEXT NOT NULL,
      transaction_id TEXT NOT NULL, resp_code TEXT NOT NULL,
      notification_json TEXT NOT NULL, response_json TEXT NOT NULL, created_at INTEGER NOT NULL
    )`);
  }

  expire(now) {
    this.sql.exec(`UPDATE voxel_2c2p_promptpay_checkouts SET status='expired'
      WHERE status='pending' AND expires_at<=?`, now);
  }

  row(invoiceNo) {
    return this.sql.exec('SELECT * FROM voxel_2c2p_promptpay_checkouts WHERE invoice_no=?', invoiceNo)
      .toArray()[0];
  }

  createCheckout({ uid, requestId, merchantID }, now = Date.now(), quotedAmount = VIP_PRODUCT.amount) {
    if (!validVipUid(uid) || !recordId(requestId) || requestId.length < 16 || !merchantId(merchantID) ||
        !integerInstant(now) || !Number.isSafeInteger(quotedAmount) || quotedAmount < 1 || quotedAmount > 100000)
      return denied('Invalid PromptPay checkout request', 400);
    return this.ctx.storage.transactionSync(() => {
      this.expire(now);
      const previous = this.sql.exec(`SELECT * FROM voxel_2c2p_promptpay_checkouts
        WHERE uid=? AND request_id=?`, uid, requestId).toArray()[0];
      if (previous) {
        if (previous.merchant_id !== merchantID || Number(previous.quoted_amount) !== quotedAmount)
          return denied('PromptPay checkout request conflict');
        return { ...safeCheckout(previous, true), replayed: true };
      }
      const pending = this.sql.exec(`SELECT * FROM voxel_2c2p_promptpay_checkouts
        WHERE uid=? AND status='pending' AND expires_at>? ORDER BY created_at DESC LIMIT 1`, uid, now).toArray()[0];
      if (pending) return { ...safeCheckout(pending, true), replayed: true };
      for (let attempt = 0; attempt < 16; attempt++) {
        const invoiceNo = invoiceNumber();
        if (this.row(invoiceNo)) continue;
        this.sql.exec(`INSERT INTO voxel_2c2p_promptpay_checkouts
          (invoice_no,uid,request_id,merchant_id,quoted_amount,currency_code,status,created_at,expires_at)
          VALUES (?,?,?,?,?,'THB','pending',?,?)`, invoiceNo, uid, requestId, merchantID, quotedAmount,
        now, now + PROMPTPAY_CHECKOUT_TTL_MS);
        return { ...safeCheckout(this.row(invoiceNo)), replayed: false };
      }
      return denied('PromptPay invoice allocation unavailable', 503);
    });
  }

  checkout(invoiceNo, now = Date.now(), includeQr = false) {
    if (!invoiceId(invoiceNo) || !integerInstant(now)) return denied('Invalid PromptPay invoice', 400);
    return this.ctx.storage.transactionSync(() => {
      this.expire(now);
      const row = this.row(invoiceNo);
      return row ? { ...safeCheckout(row, includeQr), uid: row.uid } : denied('PromptPay checkout not found', 404);
    });
  }

  claimProviderAttempt({ invoiceNo, uid }, now = Date.now()) {
    if (!invoiceId(invoiceNo) || !validVipUid(uid) || !integerInstant(now))
      return denied('Invalid PromptPay provider attempt', 400);
    return this.ctx.storage.transactionSync(() => {
      this.expire(now);
      const row = this.row(invoiceNo);
      if (!row || row.uid !== uid) return denied('PromptPay checkout not found', 404);
      if (row.status !== 'pending') return denied('PromptPay checkout is no longer payable');
      if (row.provider_state === 'ready' && row.qr_url)
        return { ...safeCheckout(row, true), replayed: true };
      if (row.provider_state !== 'unrequested') return denied('PromptPay provider attempt is already fenced');
      this.sql.exec(`UPDATE voxel_2c2p_promptpay_checkouts
        SET provider_state='requesting' WHERE invoice_no=?`, invoiceNo);
      return safeCheckout(this.row(invoiceNo));
    });
  }

  finishProviderAttempt({ invoiceNo, uid, succeeded, qrImageUrl = null }, now = Date.now()) {
    if (!invoiceId(invoiceNo) || !validVipUid(uid) || typeof succeeded !== 'boolean' || !integerInstant(now) ||
        (succeeded && (typeof qrImageUrl !== 'string' || qrImageUrl.length < 10 || qrImageUrl.length > 2048)))
      return denied('Invalid PromptPay provider outcome', 400);
    return this.ctx.storage.transactionSync(() => {
      this.expire(now);
      const row = this.row(invoiceNo);
      if (!row || row.uid !== uid) return denied('PromptPay checkout not found', 404);
      if (row.provider_state === 'ready' && succeeded && row.qr_url === qrImageUrl)
        return { ...safeCheckout(row, true), replayed: true };
      if (row.provider_state !== 'requesting') return denied('PromptPay provider outcome is not owned');
      if (row.status !== 'pending') return denied('PromptPay checkout is no longer payable');
      this.sql.exec(`UPDATE voxel_2c2p_promptpay_checkouts
        SET provider_state=?,qr_url=? WHERE invoice_no=?`,
      succeeded ? 'ready' : 'failed', succeeded ? qrImageUrl : null, invoiceNo);
      return { ...safeCheckout(this.row(invoiceNo), true), replayed: false };
    });
  }

  applyNotification({ notification, fingerprint }, now = Date.now()) {
    if (!notification || typeof notification !== 'object' || Array.isArray(notification) ||
        !fingerprintId(fingerprint) || !integerInstant(now) || !merchantId(notification.merchantID) ||
        !invoiceId(notification.invoiceNo) || !Number.isSafeInteger(notification.amount) ||
        notification.amount < 1 || notification.amount > 100000 || notification.currencyCode !== 'THB' ||
        !recordId(notification.transactionId, 255) || !recordId(notification.referenceNo, 255) ||
        typeof notification.respCode !== 'string' || !/^\d{4}$/.test(notification.respCode) ||
        typeof notification.transactionDateTime !== 'string' || !/^\d{14}$/.test(notification.transactionDateTime))
      return denied('Invalid verified PromptPay notification', 400);
    return this.ctx.storage.transactionSync(() => {
      const receipt = this.sql.exec(`SELECT notification_json,response_json
        FROM voxel_2c2p_promptpay_notifications WHERE fingerprint=?`, fingerprint).toArray()[0];
      if (receipt) {
        if (receipt.notification_json !== JSON.stringify(notification))
          return denied('PromptPay notification fingerprint conflict');
        return { ...JSON.parse(receipt.response_json), entitlementGranted: false, replayed: true };
      }
      this.expire(now);
      const row = this.row(notification.invoiceNo);
      if (!row) return denied('PromptPay checkout not found', 404);
      if (row.merchant_id !== notification.merchantID || Number(row.quoted_amount) !== notification.amount ||
          row.currency_code !== notification.currencyCode)
        return denied('PromptPay payment does not match its checkout', 400);
      const owner = this.sql.exec(`SELECT invoice_no,transaction_id,reference_no
        FROM voxel_2c2p_promptpay_checkouts WHERE transaction_id=? OR reference_no=?`,
      notification.transactionId, notification.referenceNo).toArray()[0];
      if (owner && (owner.invoice_no !== row.invoice_no || owner.transaction_id !== notification.transactionId ||
          owner.reference_no !== notification.referenceNo))
        return denied('PromptPay transaction belongs to another invoice');
      const category = categories.get(notification.respCode) || 'unconfirmed';
      let result;
      if (row.status === 'paid') {
        if (category === 'paid' && (row.transaction_id !== notification.transactionId ||
            row.reference_no !== notification.referenceNo))
          return denied('PromptPay invoice already paid by another transaction');
        result = { ok: true, invoiceNo: row.invoice_no, status: 'paid',
          entitlementGranted: false, replayed: true, ignored: category !== 'paid' };
      } else if (row.status !== 'pending') {
        if (category === 'paid') return denied('PromptPay checkout is no longer payable');
        result = { ok: true, invoiceNo: row.invoice_no, status: row.status,
          entitlementGranted: false, replayed: false };
      } else if (category === 'paid') {
        if (!['requesting', 'ready'].includes(row.provider_state))
          return denied('PromptPay provider attempt is not confirmed');
        const applied = this.vip.applyVerifiedPromptPayPurchase({
          uid: row.uid, invoiceNo: row.invoice_no, fingerprint,
          quotedAmount: Number(row.quoted_amount)
        });
        if (!applied.ok) return applied;
        this.sql.exec(`UPDATE voxel_2c2p_promptpay_checkouts SET
          status='paid',transaction_id=?,reference_no=?,transaction_date_time=? WHERE invoice_no=?`,
        notification.transactionId, notification.referenceNo, notification.transactionDateTime, row.invoice_no);
        result = { ok: true, invoiceNo: row.invoice_no, status: 'paid',
          entitlementGranted: true, expiresAt: applied.expiresAt, replayed: false };
      } else {
        if (['failed', 'cancelled', 'expired'].includes(category))
          this.sql.exec('UPDATE voxel_2c2p_promptpay_checkouts SET status=? WHERE invoice_no=?', category, row.invoice_no);
        result = { ok: true, invoiceNo: row.invoice_no, status: category,
          entitlementGranted: false, replayed: false };
      }
      this.sql.exec(`INSERT INTO voxel_2c2p_promptpay_notifications
        (fingerprint,invoice_no,transaction_id,resp_code,notification_json,response_json,created_at)
        VALUES (?,?,?,?,?,?,?)`, fingerprint, row.invoice_no, notification.transactionId,
      notification.respCode, JSON.stringify(notification), JSON.stringify(result), now);
      return result;
    });
  }
}
