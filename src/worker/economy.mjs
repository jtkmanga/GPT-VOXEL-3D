import { RESPAWN_MS, LUCKY_BOX_CLAIM_MS, LUCKY_BOX_RESPAWN_MS, LUCKY_BOX_MIN_DISTANCE_FROM_SPAWN, SERVER_WORLD_SEED } from '../shared/config.mjs';
import { WS_MESSAGE } from '../shared/protocol.mjs';
import { COINS, coinPosition, luckyBoxPosition, safeWorldPosition, secureLuckyReward } from './world.mjs';

// One store belongs to the logical server, never to an individual zone. The
// resource transition, persisted score and durable action receipt commit in
// the same SQLite transaction.
export class EconomyStore {
  constructor(ctx, players) {
    this.ctx = ctx;
    this.sql = ctx.storage.sql;
    this.players = players;
    const columns = new Set(this.sql.exec('PRAGMA table_info(voxel_lucky_box)').toArray().map(row => row.name));
    for (const [name, definition] of [['spawn_x', 'REAL'], ['spawn_z', 'REAL'], ['spawn_cycle', 'INTEGER NOT NULL DEFAULT -1'], ['claim_cycle', 'INTEGER NOT NULL DEFAULT -1']]) {
      if (!columns.has(name)) this.sql.exec(`ALTER TABLE voxel_lucky_box ADD COLUMN ${name} ${definition}`);
    }
    // Pending P5 claims start the requested collection-time cooldown using
    // their already-durable claim deadline; restarting never renews it.
    ctx.storage.transactionSync(() => {
      const row = this.sql.exec('SELECT * FROM voxel_lucky_box WHERE id=1').toArray()[0];
      if (row?.claimed_uid && Number(row.claim_cycle) === -1) {
        const collectedAt = Number(row.claim_expires_at) - LUCKY_BOX_CLAIM_MS;
        if (!Number.isSafeInteger(collectedAt) || collectedAt < 0 || collectedAt > Date.now() ||
            !Number.isSafeInteger(collectedAt + LUCKY_BOX_RESPAWN_MS) ||
            Number(row.next_spawn_at) !== 0 || !Number.isSafeInteger(Number(row.cycle) + 1) || Number(row.cycle) < 0)
          throw Error('Invalid legacy Lucky Box claim');
        this.sql.exec('UPDATE voxel_lucky_box SET next_spawn_at=?,claim_cycle=?,cycle=? WHERE id=1',
          collectedAt + LUCKY_BOX_RESPAWN_MS, Number(row.cycle), Number(row.cycle) + 1);
      }
      if (row?.claimed_uid && Number(row.claim_expires_at) <= Date.now())
        this.sql.exec('UPDATE voxel_lucky_box SET claimed_uid=NULL,claim_expires_at=0,claim_cycle=-1 WHERE id=1');
    });
    this.sql.exec(`CREATE TABLE IF NOT EXISTS voxel_economy_actions (
      action_key TEXT PRIMARY KEY,
      uid TEXT NOT NULL,
      kind TEXT NOT NULL,
      resource_id INTEGER NOT NULL,
      cycle INTEGER NOT NULL,
      request_id TEXT,
      awarded INTEGER NOT NULL DEFAULT 0,
      response_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`);
    this.sql.exec('CREATE UNIQUE INDEX IF NOT EXISTS voxel_economy_request_idx ON voxel_economy_actions(uid,request_id) WHERE request_id IS NOT NULL');
    this.sql.exec("CREATE UNIQUE INDEX IF NOT EXISTS voxel_economy_reward_idx ON voxel_economy_actions(kind,resource_id,cycle) WHERE awarded=1 AND kind IN ('coin','spin')");
  }

  actionId(value) {
    if (value === undefined) return null;
    if (typeof value === 'string' && value.length > 0 && value.length <= 128) return `string:${value}`;
    if (Number.isSafeInteger(value) && value >= 0) return `number:${value}`;
    throw Error('Invalid economy action ID');
  }

  score(uid) {
    const row = this.sql.exec('SELECT score FROM voxel_scores WHERE uid=?', uid).toArray()[0];
    if (!row || !Number.isSafeInteger(Number(row.score)) || Number(row.score) < 0) throw Error('Score state unavailable');
    return Number(row.score);
  }

  previous(uid, kind, resourceId, requestId, now) {
    const key = this.actionId(requestId);
    if (key === null) return null;
    const row = this.sql.exec('SELECT * FROM voxel_economy_actions WHERE uid=? AND request_id=?', uid, key).toArray()[0];
    if (!row) return null;
    if (row.kind !== kind || Number(row.resource_id) !== resourceId)
      return { ok:false, error:'Action ID already used', status:409 };
    const result = JSON.parse(row.response_json);
    result.receipt = row.action_key;
    result.replayed = true;
    result.serverNow = now;
    if (Object.hasOwn(result, 'score')) result.score = this.score(uid);
    if (kind === 'coin' && result.collected) result.event = this.coinEvent(resourceId, now);
    if (kind === 'claim' || kind === 'spin') {
      result.box = this.boxSnapshot(now);
      if (kind === 'claim') {
        const box = this.sql.exec('SELECT claim_cycle,claimed_uid,claim_expires_at FROM voxel_lucky_box WHERE id=1').toArray()[0];
        result.claimed = Boolean(result.claimed && Number(box.claim_cycle) === Number(row.cycle) &&
          box.claimed_uid === uid && Number(box.claim_expires_at) > now);
      }
    }
    return result;
  }

  remember(uid, kind, resourceId, cycle, requestId, result, awarded, now) {
    // Only completed mutations own an action identity. A provisional denial
    // cannot permanently lock a later valid contact behind a stale position.
    // Successful legacy rewards still get the resource-cycle uniqueness fence.
    const key = this.actionId(requestId);
    if (requestId !== undefined) result.requestId = requestId;
    if (!awarded && !(kind === 'claim' && result.claimed)) return result;
    const receipt = crypto.randomUUID();
    result.receipt = receipt;
    this.sql.exec(`INSERT INTO voxel_economy_actions
      (action_key,uid,kind,resource_id,cycle,request_id,awarded,response_json,created_at)
      VALUES (?,?,?,?,?,?,?,?,?)`, receipt, uid, kind, resourceId, cycle, key,
    awarded ? 1 : 0, JSON.stringify(result), now);
    return result;
  }

  coinRow(id) {
    return this.sql.exec('SELECT respawn_at,cycle FROM voxel_coins WHERE id=?', id).toArray()[0] || { respawn_at:0, cycle:0 };
  }

  coinEvent(id, now) {
    const row = this.coinRow(id);
    const cycle = Number(row.cycle) || 0;
    const pos = coinPosition(id, cycle);
    return { type:WS_MESSAGE.COIN_COLLECTED, id, x:pos.x, z:pos.z, cycle,
      respawnAt:Number(row.respawn_at) || 0, serverNow:now };
  }

  coinSnapshot() {
    const rows = new Map(this.sql.exec('SELECT id,respawn_at,cycle FROM voxel_coins').toArray()
      .map(row => [Number(row.id), row]));
    return COINS.map((_, id) => {
      const row = rows.get(id) || { respawn_at:0, cycle:0 };
      const cycle = Number(row.cycle) || 0;
      const pos = coinPosition(id, cycle);
      return { id, x:pos.x, z:pos.z, cycle, respawnAt:Number(row.respawn_at) || 0 };
    });
  }

  collectCoin({ uid, id, position, requestId, now = Date.now() }) {
    return this.ctx.storage.transactionSync(() => {
      const previous = this.previous(uid, 'coin', id, requestId, now);
      if (previous) return previous;
      this.score(uid); // Never consume a resource if its reward cannot persist.
      const row = this.coinRow(id);
      const cycle = Number(row.cycle) || 0;
      const oldPosition = coinPosition(id, cycle);
      if (Number(row.respawn_at) > now) return this.remember(uid, 'coin', id, cycle, requestId,
        { ok:true, collected:false, id, activeAfter:Number(row.respawn_at), serverNow:now }, false, now);
      if (Math.hypot(position.x - oldPosition.x, position.z - oldPosition.z) > 2.35 || position.y > 2.6)
        return this.remember(uid, 'coin', id, cycle, requestId,
          { ok:false, error:'Too far from coin', status:403 }, false, now);
      const entitlement = this.sql.exec('SELECT coin_expires FROM voxel_entitlements WHERE uid=?', uid).toArray()[0];
      const reward = Number(entitlement?.coin_expires || 0) > now ? 2 : 1;
      this.sql.exec(`INSERT INTO voxel_coins(id,respawn_at,cycle) VALUES (?,?,?)
        ON CONFLICT(id) DO UPDATE SET respawn_at=excluded.respawn_at,cycle=excluded.cycle`, id, now + RESPAWN_MS, cycle + 1);
      this.sql.exec('UPDATE voxel_scores SET score=score+?,updated_at=? WHERE uid=?', reward, now, uid);
      const result = { ok:true, collected:true, event:this.coinEvent(id, now), score:this.score(uid),
        reward, oldPosition, serverNow:now };
      return this.remember(uid, 'coin', id, cycle, requestId, result, true, now);
    });
  }

  chooseBoxPosition(cycle, now) {
    const players = this.players(now);
    const clear = pos => players.every(player => Math.hypot(pos.x - player.x, pos.z - player.z) >= 6);
    const canonical = luckyBoxPosition(cycle);
    if (clear(canonical)) return canonical;
    for (let attempt = 1; attempt <= 4096; attempt++) {
      const pos = safeWorldPosition(`${SERVER_WORLD_SEED}:lucky-box-${cycle}:avoid-players:${attempt}`, LUCKY_BOX_MIN_DISTANCE_FROM_SPAWN, 20);
      if (clear(pos)) return pos;
    }
    // An exhausted world must not spawn a reward on an occupied position.
    throw Error('No safe Lucky Box spawn position');
  }

  boxSnapshot(now = Date.now()) {
    return this.ctx.storage.transactionSync(() => {
      let row = this.sql.exec('SELECT * FROM voxel_lucky_box WHERE id=1').toArray()[0];
      if (!row) throw Error('Lucky Box state missing');
      if (row.claimed_uid && Number(row.claim_expires_at) <= now) {
        this.sql.exec('UPDATE voxel_lucky_box SET claimed_uid=NULL,claim_expires_at=0,claim_cycle=-1 WHERE id=1');
        row = { ...row, claimed_uid:null, claim_expires_at:0, claim_cycle:-1 };
      }
      const cycle = Number(row.cycle) || 0;
      let position = luckyBoxPosition(cycle);
      if (Number(row.next_spawn_at) <= now) {
        if (Number(row.spawn_cycle) !== cycle || !Number.isFinite(row.spawn_x) || !Number.isFinite(row.spawn_z)) {
          position = row.claimed_uid ? position : this.chooseBoxPosition(cycle, now);
          this.sql.exec('UPDATE voxel_lucky_box SET spawn_x=?,spawn_z=?,spawn_cycle=? WHERE id=1', position.x, position.z, cycle);
        } else position = { x:Number(row.spawn_x), z:Number(row.spawn_z) };
      }
      const claimed = Boolean(row.claimed_uid && Number(row.claim_expires_at) > now);
      return { active:Number(row.next_spawn_at) <= now && !claimed, x:position.x, z:position.z,
        nextSpawnAt:Number(row.next_spawn_at) || 0, cycle, claimed,
        claimExpiresAt:Number(row.claim_expires_at) || 0, serverNow:now };
    });
  }

  claimBox({ uid, position, requestId, now = Date.now() }) {
    return this.ctx.storage.transactionSync(() => {
      const previous = this.previous(uid, 'claim', 1, requestId, now);
      if (previous) return previous;
      this.score(uid);
      const snapshot = this.boxSnapshot(now);
      const result = { ok:true, claimed:false, box:snapshot, serverNow:now };
      if (!snapshot.active) return this.remember(uid, 'claim', 1, snapshot.cycle, requestId, result, false, now);
      if (Math.hypot(position.x - snapshot.x, position.z - snapshot.z) > 2.8 || position.y > 3.2)
        return this.remember(uid, 'claim', 1, snapshot.cycle, requestId,
          { ok:false, error:'Too far from Lucky Box', status:403 }, false, now);
      this.sql.exec('UPDATE voxel_lucky_box SET claimed_uid=?,claim_expires_at=?,claim_cycle=?,next_spawn_at=?,cycle=? WHERE id=1',
        uid, now + LUCKY_BOX_CLAIM_MS, snapshot.cycle, now + LUCKY_BOX_RESPAWN_MS, snapshot.cycle + 1);
      result.claimed = true;
      result.box = this.boxSnapshot(now);
      return this.remember(uid, 'claim', 1, snapshot.cycle, requestId, result, false, now);
    });
  }

  spinBox({ uid, requestId, now = Date.now() }) {
    return this.ctx.storage.transactionSync(() => {
      const previous = this.previous(uid, 'spin', 1, requestId, now);
      if (previous) return previous;
      this.score(uid);
      const row = this.sql.exec('SELECT * FROM voxel_lucky_box WHERE id=1').toArray()[0];
      if (!row) throw Error('Lucky Box state missing');
      const cycle = Number(row.claim_cycle);
      if (!Number.isSafeInteger(cycle) || cycle < 0)
        return { ok:false, error:'Lucky Box claim expired', status:409 };
      if (row.claimed_uid !== uid || Number(row.claim_expires_at) <= now)
        return this.remember(uid, 'spin', 1, cycle, requestId,
          { ok:false, error:'Lucky Box claim expired', status:409 }, false, now);
      const reward = secureLuckyReward();
      this.sql.exec('UPDATE voxel_scores SET score=score+?,updated_at=? WHERE uid=?', reward, now, uid);
      // Collection already advanced the global spawn cycle and fixed cooldown.
      // Reward delivery cannot postpone respawn or create a new resource cycle.
      this.sql.exec('UPDATE voxel_lucky_box SET claimed_uid=NULL,claim_expires_at=0,claim_cycle=-1 WHERE id=1');
      const result = { ok:true, reward, score:this.score(uid), box:this.boxSnapshot(now), serverNow:now };
      return this.remember(uid, 'spin', 1, cycle, requestId, result, true, now);
    });
  }
}
