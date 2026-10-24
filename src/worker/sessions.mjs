import { MOVEMENT } from '../shared/movement.mjs';
import { normalizeZoneId, zoneFromPosition } from './spatial.mjs';

// Private logical-server session authority. Callers must first verify Firebase
// identity; no client-supplied UID or entitlement is accepted by this store.
export const SESSION_TTL_MS = 120_000;

function nonemptyString(value, maximum = 256) {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum;
}

function finitePosition(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === 4 && ['x', 'y', 'z', 'r'].every(key =>
      Object.hasOwn(value, key) && typeof value[key] === 'number' && Number.isFinite(value[key])) &&
    Math.abs(value.x) <= MOVEMENT.bounds && Math.abs(value.z) <= MOVEMENT.bounds &&
    value.y >= 0 && value.y <= 8 && Math.abs(value.r) <= 10_000);
}

function storedPosition(row) {
  return { x: Number(row.x), y: Number(row.y), z: Number(row.z), r: Number(row.r) };
}

function positionFingerprint(position) {
  return JSON.stringify(['x', 'y', 'z', 'r'].map(key => position[key]));
}

function expiry(value) {
  return value === undefined || value === null ? 0 : value;
}

function validRevision(value) {
  return Number.isSafeInteger(value) && value >= 0;
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
      exp INTEGER NOT NULL DEFAULT 0,
      save_revision INTEGER NOT NULL DEFAULT 0,
      save_fingerprint TEXT NOT NULL DEFAULT ''
    )`);
    // Additive migration preserves every P0-P5 saved player/session. Inspect
    // columns rather than swallowing a storage error as an already-run change.
    const columns = new Set(this.sql.exec('PRAGMA table_info(voxel_sessions)').toArray().map(row => row.name));
    if (!columns.has('save_revision'))
      this.sql.exec('ALTER TABLE voxel_sessions ADD COLUMN save_revision INTEGER NOT NULL DEFAULT 0');
    if (!columns.has('save_fingerprint'))
      this.sql.exec("ALTER TABLE voxel_sessions ADD COLUMN save_fingerprint TEXT NOT NULL DEFAULT ''");
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
      (uid,session_id,owner,player_id,resume_token,resume_expires,lease_expires,x,y,z,r,exp,save_revision,save_fingerprint)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(uid) DO UPDATE SET
        session_id=excluded.session_id, owner=excluded.owner,
        player_id=excluded.player_id, resume_token=excluded.resume_token,
        resume_expires=excluded.resume_expires, lease_expires=excluded.lease_expires,
        x=excluded.x, y=excluded.y, z=excluded.z, r=excluded.r, exp=excluded.exp,
        save_revision=excluded.save_revision, save_fingerprint=excluded.save_fingerprint`,
    row.uid, row.session_id, row.owner, row.player_id, row.resume_token,
    row.resume_expires, row.lease_expires, row.x, row.y, row.z, row.r, row.exp,
    row.save_revision, row.save_fingerprint);
  }

  result(row, previous, resumed = false) {
    return {
      ok: true,
      sessionId: row.session_id,
      playerId: row.player_id,
      resumeToken: row.resume_token,
      resumeExpiresAt: Number(row.resume_expires),
      checkpointRevision: Number(row.save_revision),
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
      if (previous && (!nonemptyString(previous.player_id) || !finitePosition(storedPosition(previous)) ||
          !validRevision(Number(previous.save_revision))))
        return { ok: false, error: 'Invalid persisted player state' };
      // A verified login, even after ticket expiry or process restart, restores
      // the durable player identity and last authoritative checkpoint. Zone
      // routing may redirect before any owner/session mutation takes place.
      const savedPosition = previous ? storedPosition(previous) : null;
      const savedZone = savedPosition ? zoneFromPosition(savedPosition.x, savedPosition.z) : null;
      const priorZone = previous?.owner?.startsWith('zone:') ? normalizeZoneId(previous.owner.slice(5)) : null;
      const zoneOwnerChanged = previous && previous.owner !== owner && owner.startsWith('zone:');
      // Preserve P5's explicit active cross-zone replacement and distinct
      // legacy-room -> zone admission policies. The spawn is authored by the
      // target server. A released valid zone owner instead retains its save.
      const approvedZoneReplacement = !wantsResume && zoneOwnerChanged &&
        (this.isLive(previous, now) || previous.owner === 'room' || priorZone !== savedZone);
      const nextPosition = previous && !approvedZoneReplacement ? savedPosition : position;
      if (!wantsResume && previous && owner.startsWith('zone:')) {
        const targetZone = normalizeZoneId(owner.slice(5));
        if (!targetZone || owner !== `zone:${targetZone}`)
          return { ok: false, error: 'Invalid session owner' };
        if (zoneOwnerChanged && !approvedZoneReplacement && savedZone !== targetZone)
          return { ok: false, error: 'Saved player belongs to another zone', resumeZone: savedZone };
      }
      if (previous && !validRevision(Number(previous.save_revision) + (approvedZoneReplacement ? 1 : 0)))
        return { ok: false, error: 'Invalid persisted player state' };
      const row = {
        uid,
        // Rotating the session generation invalidates an old socket even when
        // a reconnect remains in the same zone and preserves the player ID.
        session_id: crypto.randomUUID(),
        owner,
        player_id: previous ? previous.player_id : playerId,
        resume_token: crypto.randomUUID(),
        resume_expires: now + SESSION_TTL_MS,
        lease_expires: now + SESSION_TTL_MS,
        ...nextPosition,
        exp: tokenExpiry,
        save_revision: previous ? Number(previous.save_revision) + (approvedZoneReplacement ? 1 : 0) : 0,
        save_fingerprint: positionFingerprint(nextPosition)
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

  checkpoint(payload) {
    const { uid, sessionId, owner, position, exp, revision } = payload || {};
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
        Object.keys(payload).some(key => !['uid', 'sessionId', 'owner', 'position', 'exp', 'revision'].includes(key)) ||
        !nonemptyString(uid, 128) || !nonemptyString(sessionId) || !nonemptyString(owner, 128) ||
        (position !== undefined && !finitePosition(position)) ||
        (exp !== undefined && (!Number.isSafeInteger(exp) || exp < 0)) ||
        (revision !== undefined && (position === undefined || !validRevision(revision))))
      return { ok: false, error: 'Invalid session checkpoint' };
    return this.ctx.storage.transactionSync(() => {
      const now = Date.now();
      const row = this.row(uid);
      if (!this.identityMatches(row, { uid, sessionId, owner }) || !this.isLive(row, now))
        return { ok: false, error: 'Session no longer owned' };
      if (exp && exp <= Math.floor(now / 1000))
        return { ok: false, error: 'Expired authentication' };
      if (!validRevision(Number(row.save_revision)))
        return { ok: false, error: 'Invalid persisted player state' };
      if (position !== undefined) {
        const currentRevision = Number(row.save_revision);
        const fingerprint = positionFingerprint(position);
        // P6 runtime position writes always carry a server-authored revision.
        // Omission remains private compatibility for P0-P5 trusted fixtures;
        // there is no browser save API or public revision-controlled write.
        const nextRevision = revision ?? currentRevision + 1;
        if (!validRevision(nextRevision) || nextRevision < currentRevision)
          return { ok: false, error: 'Stale session checkpoint' };
        if (nextRevision === currentRevision) {
          if (fingerprint !== row.save_fingerprint || (exp !== undefined && exp !== Number(row.exp)))
            return { ok: false, error: 'Conflicting session checkpoint' };
          return { ok: true, replayed: true, checkpointRevision: currentRevision,
            resumeExpiresAt: Number(row.resume_expires) };
        }
        Object.assign(row, position, { save_revision: nextRevision, save_fingerprint: fingerprint });
      }
      if (exp !== undefined) row.exp = exp;
      row.lease_expires = now + SESSION_TTL_MS;
      row.resume_expires = now + SESSION_TTL_MS;
      this.write(row);
      return { ok: true, checkpointRevision: Number(row.save_revision),
        resumeExpiresAt: Number(row.resume_expires) };
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
      if (!validRevision(Number(previous.save_revision) + 1))
        return { ok: false, error: 'Invalid persisted player state' };
      const row = {
        ...previous,
        ...position,
        owner: toOwner,
        resume_token: crypto.randomUUID(),
        resume_expires: now + SESSION_TTL_MS,
        lease_expires: now + SESSION_TTL_MS,
        save_revision: Number(previous.save_revision) + 1,
        save_fingerprint: positionFingerprint(position)
      };
      this.write(row);
      return this.result(row, previous);
    });
  }
}
