// Private logical-server session authority. Callers must first verify Firebase
// identity; no client-supplied UID or entitlement is accepted by this store.
export const SESSION_TTL_MS = 120_000;

function nonemptyString(value, maximum = 256) {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum;
}

function finitePosition(value) {
  return value && ['x', 'y', 'z', 'r'].every(key =>
    typeof value[key] === 'number' && Number.isFinite(value[key]));
}

function storedPosition(row) {
  return { x: Number(row.x), y: Number(row.y), z: Number(row.z), r: Number(row.r) };
}

function expiry(value) {
  return value === undefined || value === null ? 0 : value;
}

export class SessionStore {
  constructor(ctx) {
    this.ctx = ctx;
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS voxel_sessions (
      uid TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      owner TEXT NOT NULL,
      player_id TEXT NOT NULL,
      resume_token TEXT NOT NULL,
      resume_expires INTEGER NOT NULL,
      lease_expires INTEGER NOT NULL,
      x REAL NOT NULL,
      y REAL NOT NULL,
      z REAL NOT NULL,
      r REAL NOT NULL,
      exp INTEGER NOT NULL DEFAULT 0
    )`);
  }

  row(uid) {
    return this.sql.exec('SELECT * FROM voxel_sessions WHERE uid=?', uid).toArray()[0];
  }

  identityMatches(row, { uid, sessionId, owner }) {
    return row && row.uid === uid && row.session_id === sessionId && row.owner === owner;
  }

  isLive(row, now) {
    return row && Number(row.lease_expires) > now &&
      (!Number(row.exp) || Number(row.exp) > Math.floor(now / 1000));
  }

  write(row) {
    this.sql.exec(`INSERT INTO voxel_sessions
      (uid,session_id,owner,player_id,resume_token,resume_expires,lease_expires,x,y,z,r,exp)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(uid) DO UPDATE SET
        session_id=excluded.session_id, owner=excluded.owner,
        player_id=excluded.player_id, resume_token=excluded.resume_token,
        resume_expires=excluded.resume_expires, lease_expires=excluded.lease_expires,
        x=excluded.x, y=excluded.y, z=excluded.z, r=excluded.r, exp=excluded.exp`,
    row.uid, row.session_id, row.owner, row.player_id, row.resume_token,
    row.resume_expires, row.lease_expires, row.x, row.y, row.z, row.r, row.exp);
  }

  result(row, previous, resumed = false) {
    return {
      ok: true,
      sessionId: row.session_id,
      playerId: row.player_id,
      resumeToken: row.resume_token,
      resumeExpiresAt: Number(row.resume_expires),
      position: storedPosition(row),
      previousOwner: previous?.owner || null,
      previousSessionId: previous?.session_id || null,
      resumed
    };
  }

  acquire({ uid, owner, playerId, position, resumeToken, exp }) {
    if (!nonemptyString(uid, 128) || !nonemptyString(owner, 128) ||
        !Number.isSafeInteger(expiry(exp)) || expiry(exp) < 0)
      return { ok: false, error: 'Invalid session request' };
    const wantsResume = resumeToken !== undefined;
    if (wantsResume && !nonemptyString(resumeToken))
      return { ok: false, error: 'Invalid resume ticket' };
    if (!wantsResume && (!nonemptyString(playerId) || !finitePosition(position)))
      return { ok: false, error: 'Invalid session position' };

    // Database/transaction failures propagate. There is no in-memory fallback
    // that could authorize a second owner when durable state is unavailable.
    return this.ctx.storage.transactionSync(() => {
      const now = Date.now();
      const previous = this.row(uid);
      if (wantsResume && (!previous || previous.owner !== owner ||
          previous.resume_token !== resumeToken || Number(previous.resume_expires) <= now))
        return { ok: false, error: 'Invalid or expired resume ticket' };
      const tokenExpiry = exp === undefined || exp === null
        ? (wantsResume ? Number(previous.exp) || 0 : 0)
        : exp;
      if (tokenExpiry && tokenExpiry <= Math.floor(now / 1000))
        return { ok: false, error: 'Expired authentication' };
      const nextPosition = wantsResume ? storedPosition(previous) : position;
      const row = {
        uid,
        // Rotating the session generation invalidates an old socket even when
        // a reconnect remains in the same zone and preserves the player ID.
        session_id: crypto.randomUUID(),
        owner,
        player_id: wantsResume ? previous.player_id : playerId,
        resume_token: crypto.randomUUID(),
        resume_expires: now + SESSION_TTL_MS,
        lease_expires: now + SESSION_TTL_MS,
        ...nextPosition,
        exp: tokenExpiry
      };
      this.write(row);
      return this.result(row, previous, wantsResume);
    });
  }

  validate(identity) {
    if (!nonemptyString(identity?.uid, 128) || !nonemptyString(identity?.sessionId) ||
        !nonemptyString(identity?.owner, 128)) return false;
    const row = this.row(identity.uid);
    return Boolean(this.identityMatches(row, identity) && this.isLive(row, Date.now()));
  }

  checkpoint({ uid, sessionId, owner, position, exp }) {
    if (!nonemptyString(uid, 128) || !nonemptyString(sessionId) || !nonemptyString(owner, 128) ||
        (position !== undefined && !finitePosition(position)) ||
        (exp !== undefined && (!Number.isSafeInteger(exp) || exp < 0)))
      return { ok: false, error: 'Invalid session checkpoint' };
    return this.ctx.storage.transactionSync(() => {
      const now = Date.now();
      const row = this.row(uid);
      if (!this.identityMatches(row, { uid, sessionId, owner }) || !this.isLive(row, now))
        return { ok: false, error: 'Session no longer owned' };
      if (exp && exp <= Math.floor(now / 1000))
        return { ok: false, error: 'Expired authentication' };
      if (position !== undefined) Object.assign(row, position);
      if (exp !== undefined) row.exp = exp;
      row.lease_expires = now + SESSION_TTL_MS;
      row.resume_expires = now + SESSION_TTL_MS;
      this.write(row);
      return { ok: true, resumeExpiresAt: Number(row.resume_expires) };
    });
  }

  release({ uid, sessionId, owner }) {
    if (!nonemptyString(uid, 128) || !nonemptyString(sessionId) || !nonemptyString(owner, 128))
      return { ok: false, error: 'Invalid session release' };
    return this.ctx.storage.transactionSync(() => {
      const row = this.row(uid);
      if (!this.identityMatches(row, { uid, sessionId, owner }))
        return { ok: false, error: 'Session no longer owned' };
      // Preserve the short-lived resume ticket and last server checkpoint.
      // Delayed close callbacks cannot release a newer session generation.
      this.sql.exec('UPDATE voxel_sessions SET lease_expires=0 WHERE uid=? AND session_id=? AND owner=?',
        uid, sessionId, owner);
      return { ok: true };
    });
  }

  transfer({ uid, sessionId, fromOwner, toOwner, playerId, position }) {
    if (!nonemptyString(uid, 128) || !nonemptyString(sessionId) ||
        !nonemptyString(fromOwner, 128) || !nonemptyString(toOwner, 128) || fromOwner === toOwner ||
        !nonemptyString(playerId) || !finitePosition(position))
      return { ok: false, error: 'Invalid session transfer' };
    return this.ctx.storage.transactionSync(() => {
      const now = Date.now();
      const previous = this.row(uid);
      if (!this.identityMatches(previous, { uid, sessionId, owner: fromOwner }) ||
          !this.isLive(previous, now) || previous.player_id !== playerId)
        return { ok: false, error: 'Session transfer no longer owned' };
      const row = {
        ...previous,
        ...position,
        owner: toOwner,
        resume_token: crypto.randomUUID(),
        resume_expires: now + SESSION_TTL_MS,
        lease_expires: now + SESSION_TTL_MS
      };
      this.write(row);
      return this.result(row, previous);
    });
  }
}
