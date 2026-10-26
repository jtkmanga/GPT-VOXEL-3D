import { validVipUid } from './payment-events.mjs';

export const PROMPTPAY_CHECKOUT_TTL_MS = 15 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const denied = (error, status = 409) => ({ ok: false, error, status });
const safeId = (value, maximum = 128) => typeof value === 'string' && value.length > 0 &&
  value.length <= maximum && /^[A-Za-z0-9._:-]+$/.test(value);
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
  const parts=[value.slice(0,4),value.slice(4,6),value.slice(6,8),value.slice(8,10),value.slice(10,12),value.slice(12,14)].map(Number);
  if (parts[0] < 2000) return false;
  const d=new Date(0); d.setUTCFullYear(parts[0],parts[1]-1,parts[2]); d.setUTCHours(parts[3],parts[4],parts[5],0);
  return d.getUTCFullYear()===parts[0] && d.getUTCMonth()===parts[1]-1 && d.getUTCDate()===parts[2] &&
    d.getUTCHours()===parts[3] && d.getUTCMinutes()===parts[4] && d.getUTCSeconds()===parts[5];
}

function normalizedNotification(raw) {
  const required=['merchantID','invoiceNo','amount','currencyCode','paymentID','referenceNo','respCode','transactionDateTime'];
  const optional=['tranRef'];
  if (!raw || typeof raw!=='object' || Array.isArray(raw) ||
      required.some(key=>!Object.hasOwn(raw,key)) ||
      Object.keys(raw).some(key=>!required.includes(key)&&!optional.includes(key)) ||
      !merchantId(raw.merchantID) || !invoiceId(raw.invoiceNo) ||
      !Number.isSafeInteger(raw.amount) || raw.amount<1 || raw.amount>100000 ||
      raw.currencyCode!=='THB' || !safeId(raw.paymentID,255) || !safeId(raw.referenceNo,50) ||
      typeof raw.respCode!=='string' || !/^\d{4}$/.test(raw.respCode) ||
      !providerCivilDate(raw.transactionDateTime) ||
      (Object.hasOwn(raw,'tranRef') && !safeId(raw.tranRef,255))) return null;
  return Object.fromEntries([...required,...optional].filter(key=>Object.hasOwn(raw,key)).map(key=>[key,raw[key]]));
}

function invoiceNumber(prefix) {
  const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const random=crypto.getRandomValues(new Uint8Array(20-prefix.length));
  for (let i=0;i<random.length;i++) while (random[i]>=252) random[i]=crypto.getRandomValues(new Uint8Array(1))[0];
  return prefix+Array.from(random,v=>alphabet[v%alphabet.length]).join('');
}

function safeCheckout(row) {
  return {ok:true,invoiceNo:row.invoice_no,merchantID:row.merchant_id,amount:Number(row.amount),
    currencyCode:'THB',status:row.status,createdAt:Number(row.created_at),expiresAt:Number(row.expires_at),
    periodStart:Number(row.period_start),periodEnd:Number(row.period_end),tokenState:row.token_state,
    subscriptionId:row.subscription_id,eventVersion:Number(row.event_version)};
}

export class PromptPayStore {
  constructor(ctx,vip) {
    this.ctx=ctx; this.sql=ctx.storage.sql; this.vip=vip;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS voxel_promptpay_checkouts (
      invoice_no TEXT PRIMARY KEY, uid TEXT NOT NULL, request_id TEXT NOT NULL,
      merchant_id TEXT NOT NULL, amount INTEGER NOT NULL CHECK(amount>=1 AND amount<=100000),
      currency_code TEXT NOT NULL CHECK(currency_code='THB'), status TEXT NOT NULL,
      token_state TEXT NOT NULL DEFAULT 'unrequested', created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL, period_start INTEGER NOT NULL, period_end INTEGER NOT NULL,
      subscription_id TEXT NOT NULL, event_version INTEGER NOT NULL,
      payment_id TEXT UNIQUE, reference_no TEXT, tran_ref TEXT, transaction_date_time TEXT,
      UNIQUE(uid,request_id)
    )`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS voxel_promptpay_uid_idx
      ON voxel_promptpay_checkouts(uid,status,expires_at)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS voxel_promptpay_notifications (
      fingerprint TEXT PRIMARY KEY, invoice_no TEXT NOT NULL, payment_id TEXT NOT NULL,
      resp_code TEXT NOT NULL, notification_json TEXT NOT NULL, response_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS voxel_promptpay_transactions (
      payment_id TEXT PRIMARY KEY, reference_no TEXT NOT NULL UNIQUE,
      invoice_no TEXT NOT NULL, created_at INTEGER NOT NULL
    )`);
  }

  expire(now) {
    this.sql.exec("UPDATE voxel_promptpay_checkouts SET status='expired' WHERE status='pending' AND expires_at<=?",now);
  }

  row(invoiceNo) {
    return this.sql.exec('SELECT * FROM voxel_promptpay_checkouts WHERE invoice_no=?',invoiceNo).toArray()[0];
  }

  createCheckout(input,now=Date.now(),quotedAmount=50) {
    if (!input || typeof input!=='object' || Array.isArray(input) ||
        Object.keys(input).length!==3 || !['uid','merchantID','requestId'].every(k=>Object.hasOwn(input,k)) ||
        !validVipUid(input.uid) || !merchantId(input.merchantID) || !safeId(input.requestId) ||
        !integerInstant(now) || !Number.isSafeInteger(quotedAmount) || quotedAmount<1 || quotedAmount>100000)
      return denied('Invalid PromptPay checkout request',400);
    return this.ctx.storage.transactionSync(()=>{
      this.expire(now);
      const previous=this.sql.exec('SELECT * FROM voxel_promptpay_checkouts WHERE uid=? AND request_id=?',
        input.uid,input.requestId).toArray()[0];
      if (previous) {
        if (previous.merchant_id!==input.merchantID) return denied('Checkout request identity conflict');
        return {...safeCheckout(previous),replayed:true};
      }
      if (this.vip.entitlement(input.uid,now).active) return denied('VIP is already active; renew after expiry');
      const pending=this.sql.exec("SELECT invoice_no FROM voxel_promptpay_checkouts WHERE uid=? AND status='pending' AND expires_at>?",
        input.uid,now).toArray()[0];
      if (pending) return denied('A PromptPay checkout is already pending');
      const prior=this.sql.exec('SELECT subscription_id,version FROM voxel_vip_subscriptions WHERE uid=?',input.uid).toArray()[0];
      if (prior && !String(prior.subscription_id||'').startsWith('2c2p:promptpay:'))
        return denied('Existing VIP lifecycle uses another payment provider');
      const periodStart=now,periodEnd=now+30*DAY_MS,expiresAt=Math.min(now+PROMPTPAY_CHECKOUT_TTL_MS,periodEnd);
      for(let attempt=0;attempt<16;attempt++){
        const invoiceNo=invoiceNumber('VXP');
        if(this.row(invoiceNo))continue;
        const subscriptionId=prior?.subscription_id || `2c2p:promptpay:${invoiceNo}`;
        const eventVersion=(Number(prior?.version)||0)+1;
        this.sql.exec(`INSERT INTO voxel_promptpay_checkouts
          (invoice_no,uid,request_id,merchant_id,amount,currency_code,status,created_at,expires_at,
           period_start,period_end,subscription_id,event_version)
          VALUES (?,?,?,?,?,'THB','pending',?,?,?,?,?,?)`,
        invoiceNo,input.uid,input.requestId,input.merchantID,quotedAmount,now,expiresAt,periodStart,periodEnd,subscriptionId,eventVersion);
        return {...safeCheckout(this.row(invoiceNo)),replayed:false};
      }
      return denied('PromptPay invoice allocation unavailable',503);
    });
  }

  checkout(invoiceNo,now=Date.now()) {
    if(!invoiceId(invoiceNo)||!integerInstant(now))return denied('Invalid PromptPay invoice',400);
    return this.ctx.storage.transactionSync(()=>{
      this.expire(now); const row=this.row(invoiceNo);
      return row?{...safeCheckout(row),uid:row.uid}:denied('PromptPay checkout not found',404);
    });
  }

  claimTokenAttempt({invoiceNo,uid},now=Date.now()) {
    if(!invoiceId(invoiceNo)||!validVipUid(uid)||!integerInstant(now))return denied('Invalid PromptPay token attempt',400);
    return this.ctx.storage.transactionSync(()=>{
      this.expire(now); const row=this.row(invoiceNo);
      if(!row||row.uid!==uid)return denied('PromptPay checkout not found',404);
      if(row.status!=='pending'||row.token_state!=='unrequested')return denied('PromptPay token attempt is already fenced');
      this.sql.exec("UPDATE voxel_promptpay_checkouts SET token_state='requesting' WHERE invoice_no=?",invoiceNo);
      return safeCheckout(this.row(invoiceNo));
    });
  }

  finishTokenAttempt({invoiceNo,uid,succeeded},now=Date.now()) {
    if(!invoiceId(invoiceNo)||!validVipUid(uid)||typeof succeeded!=='boolean'||!integerInstant(now))
      return denied('Invalid PromptPay token outcome',400);
    return this.ctx.storage.transactionSync(()=>{
      this.expire(now); const row=this.row(invoiceNo);
      if(!row||row.uid!==uid)return denied('PromptPay checkout not found',404);
      const state=succeeded?'ready':'failed';
      if(row.token_state===state)return {...safeCheckout(row),replayed:true};
      if(row.token_state!=='requesting')return denied('PromptPay token outcome is not owned');
      if(row.status!=='pending')return denied('PromptPay checkout is no longer payable');
      this.sql.exec('UPDATE voxel_promptpay_checkouts SET token_state=? WHERE invoice_no=?',state,invoiceNo);
      return {...safeCheckout(this.row(invoiceNo)),replayed:false};
    });
  }

  applyNotification({notification:input,fingerprint},now=Date.now()) {
    const notification=normalizedNotification(input);
    if(!notification||!fingerprintId(fingerprint)||!integerInstant(now))
      return denied('Invalid verified PromptPay notification',400);
    return this.ctx.storage.transactionSync(()=>{
      const receipt=this.sql.exec('SELECT notification_json,response_json FROM voxel_promptpay_notifications WHERE fingerprint=?',
        fingerprint).toArray()[0];
      if(receipt){
        if(receipt.notification_json!==JSON.stringify(notification))return denied('PromptPay notification fingerprint conflict');
        return {...JSON.parse(receipt.response_json),entitlementGranted:false,replayed:true};
      }
      this.expire(now); const row=this.row(notification.invoiceNo);
      if(!row)return denied('PromptPay checkout not found',404);
      if(row.merchant_id!==notification.merchantID||Number(row.amount)!==notification.amount||row.currency_code!==notification.currencyCode)
        return denied('PromptPay payment does not match checkout',400);
      const tx=this.sql.exec('SELECT invoice_no,payment_id,reference_no FROM voxel_promptpay_transactions WHERE payment_id=? OR reference_no=?',
        notification.paymentID,notification.referenceNo).toArray()[0];
      if(tx&&(tx.invoice_no!==row.invoice_no||tx.payment_id!==notification.paymentID||tx.reference_no!==notification.referenceNo))
        return denied('PromptPay transaction belongs to another invoice');
      const category=categories.get(notification.respCode)||'unconfirmed';
      let result;
      if(row.status==='paid'){
        if(category==='paid'&&(row.payment_id!==notification.paymentID||row.reference_no!==notification.referenceNo))
          return denied('PromptPay invoice already paid by another transaction');
        result={ok:true,invoiceNo:row.invoice_no,status:'paid',entitlementGranted:false,replayed:true,ignored:category!=='paid'};
      } else if(row.status!=='pending'){
        if(category==='paid')return denied('PromptPay checkout is no longer payable');
        result={ok:true,invoiceNo:row.invoice_no,status:row.status,entitlementGranted:false,replayed:false};
      } else if(category==='paid'){
        if(!['requesting','ready'].includes(row.token_state))return denied('PromptPay token attempt is not confirmed');
        const event={eventId:`2c2p:promptpay:${fingerprint}`,subscriptionId:row.subscription_id,uid:row.uid,
          version:Number(row.event_version),status:'active',product:'vip1',amount:Number(row.amount),currency:'THB',
          periodStart:Number(row.period_start),periodEnd:Number(row.period_end)};
        const applied=this.vip.applyVerifiedPromptPayEvent({event,fingerprint,quotedAmount:Number(row.amount)});
        if(!applied.ok)return applied;
        this.sql.exec(`UPDATE voxel_promptpay_checkouts SET status='paid',payment_id=?,reference_no=?,tran_ref=?,
          transaction_date_time=? WHERE invoice_no=?`,
        notification.paymentID,notification.referenceNo,notification.tranRef??null,notification.transactionDateTime,row.invoice_no);
        result={ok:true,invoiceNo:row.invoice_no,status:'paid',entitlementGranted:true,expiresAt:event.periodEnd,replayed:false};
      } else {
        if(['failed','cancelled','expired'].includes(category))
          this.sql.exec('UPDATE voxel_promptpay_checkouts SET status=? WHERE invoice_no=?',category,row.invoice_no);
        result={ok:true,invoiceNo:row.invoice_no,status:category,entitlementGranted:false,replayed:false};
      }
      this.sql.exec('INSERT OR IGNORE INTO voxel_promptpay_transactions(payment_id,reference_no,invoice_no,created_at) VALUES (?,?,?,?)',
        notification.paymentID,notification.referenceNo,row.invoice_no,now);
      this.sql.exec(`INSERT INTO voxel_promptpay_notifications
        (fingerprint,invoice_no,payment_id,resp_code,notification_json,response_json,created_at) VALUES (?,?,?,?,?,?,?)`,
        fingerprint,row.invoice_no,notification.paymentID,notification.respCode,JSON.stringify(notification),JSON.stringify(result),now);
      return result;
    });
  }
}
