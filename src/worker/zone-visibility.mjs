import { BORDER_SNAPSHOT_INTERVAL_MS, PLAYER_VISIBILITY_RADIUS, ZONE_SOFT_CAP } from '../shared/config.mjs';
import { WS_MESSAGE } from '../shared/protocol.mjs';
import { adjacentZoneIds, normalizePlayerName, normalizeZoneId, zonesAreAdjacent } from './spatial.mjs';
import { nearbyPublicPlayers, playerCanReachZone } from './zone-routing.mjs';

// Zone-local projection data. Ownership and world/economy state continue to
// come from their existing authoritative stores, never from this cache.
export class ZoneVisibility {
  constructor(room) {
    this.room=room;
    this.sql=room.ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS voxel_border_snapshots (
      source_zone TEXT PRIMARY KEY, revision INTEGER NOT NULL, server_now INTEGER NOT NULL,
      received_at INTEGER NOT NULL, players TEXT NOT NULL
    )`);
    this.sql.exec('CREATE TABLE IF NOT EXISTS voxel_border_revision (id INTEGER PRIMARY KEY, revision INTEGER NOT NULL)');
    this.sql.exec('INSERT OR IGNORE INTO voxel_border_revision(id,revision) VALUES (1,0)');
    this.routing=null;
    this.routingPending=null;
  }

  nextRevision() {
    return this.room.ctx.storage.transactionSync(()=>{
      this.sql.exec('UPDATE voxel_border_revision SET revision=revision+1 WHERE id=1');
      return Number(this.sql.exec('SELECT revision FROM voxel_border_revision WHERE id=1').toArray()[0].revision);
    });
  }

  async activeAdjacentZones() {
    const now=Date.now();
    if (this.routing && now-this.routing.at<BORDER_SNAPSHOT_INTERVAL_MS) return this.routing.zones;
    if (this.routingPending) return this.routingPending;
    const sourceZone=this.room.currentZoneId();
    if (!sourceZone) return [];
    this.routingPending=(async()=>{
      const response=await this.room.env.ROOM.getByName('free-v2-demo').fetch(
        new Request(`https://internal/_internal/active-zones?zone=${encodeURIComponent(sourceZone)}`));
      const result=await response.json();
      if (!response.ok || !result?.ok || !Array.isArray(result.zones))
        throw Error('Routing authority unavailable');
      const allowed=new Set(adjacentZoneIds(sourceZone));
      const zones=[...new Set(result.zones.map(normalizeZoneId).filter(zone=>allowed.has(zone)))];
      this.routing={at:now,zones};
      return zones;
    })();
    try { return await this.routingPending; }
    finally { this.routingPending=null; }
  }

  snapshot(destinationZone=null,exceptWs=null) {
    const players=this.room.borderPlayers(exceptWs);
    return {sourceZone:this.room.currentZoneId(),revision:this.nextRevision(),
      players:destinationZone ? players.filter(p=>playerCanReachZone(p,destinationZone)) : players,
      serverNow:Date.now()};
  }

  async flush(force=false,exceptWs=null) {
    const now=Date.now();
    if (!force && now-this.room.lastBorderFlushAt<BORDER_SNAPSHOT_INTERVAL_MS) return;
    this.room.lastBorderFlushAt=now;
    const sourceZone=this.room.currentZoneId();
    if (!sourceZone) return;
    if (force) this.routing=null;
    const destinations=await this.activeAdjacentZones();
    if (!destinations.length) return;
    const snapshot=this.snapshot(null,exceptWs);
    await Promise.allSettled(destinations.map(zoneId=>this.room.env.ZONE.getByName(`free-zone-${zoneId}`).fetch(
      new Request('https://zone.internal/_internal/border-snapshot',{
        method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({...snapshot,players:snapshot.players.filter(p=>playerCanReachZone(p,zoneId))})
      }))));
  }

  normalizeSnapshot(body) {
    const sourceZone=normalizeZoneId(body?.sourceZone);
    if (!sourceZone || !zonesAreAdjacent(this.room.currentZoneId(),sourceZone)) return {error:403};
    const rawPlayers=Array.isArray(body.players) ? body.players : [];
    if (rawPlayers.length>ZONE_SOFT_CAP+20) return {error:413};
    const players=[];
    for (const item of rawPlayers) {
      const id=typeof item?.id==='string' ? item.id : '';
      const x=Number(item?.x),y=Number(item?.y),z=Number(item?.z),r=Number(item?.r);
      if (!id || id.length>128 || ![x,y,z,r].every(Number.isFinite)) continue;
      if (Math.abs(x)>748 || Math.abs(z)>748 || y<-.25 || y>8 || Math.abs(r)>10000) continue;
      players.push({id,x,y,z,r,name:normalizePlayerName(item.name,'Player')});
    }
    const serverNow=Number(body.serverNow);
    const revision=body.revision===undefined ? 0 : Number(body.revision);
    if (!Number.isFinite(serverNow) || serverNow<0 || serverNow>Date.now()+BORDER_SNAPSHOT_INTERVAL_MS ||
        !Number.isSafeInteger(revision) || revision<0)
      return {error:400};
    return {sourceZone,players,serverNow,revision};
  }

  storeSnapshot(snapshot) {
    return this.room.ctx.storage.transactionSync(()=>{
      const old=this.sql.exec('SELECT revision,server_now FROM voxel_border_snapshots WHERE source_zone=?',snapshot.sourceZone).toArray()[0];
      if (old && (snapshot.serverNow<Number(old.server_now) ||
          (snapshot.revision>0 ? snapshot.revision<=Number(old.revision) :
            Number(old.revision)>0 || snapshot.serverNow<=Number(old.server_now)))) return false;
      this.sql.exec(`INSERT INTO voxel_border_snapshots(source_zone,revision,server_now,received_at,players)
        VALUES (?,?,?,?,?) ON CONFLICT(source_zone) DO UPDATE SET revision=excluded.revision,
        server_now=excluded.server_now,received_at=excluded.received_at,players=excluded.players`,
        snapshot.sourceZone,snapshot.revision,snapshot.serverNow,Math.min(Date.now(),snapshot.serverNow),JSON.stringify(snapshot.players));
      return true;
    });
  }

  project(ws,p,sourceZone,players,serverNow) {
    if (!this.room.activePlayer(p) || ws.readyState!==1) return;
    const visible=nearbyPublicPlayers(players,p,PLAYER_VISIBILITY_RADIUS);
    const fingerprint=JSON.stringify(visible);
    p.ghostViews ||= {};
    if (p.ghostViews[sourceZone]===fingerprint) return;
    p.ghostViews[sourceZone]=fingerprint;
    ws.serializeAttachment(p);
    this.room.send(ws,{type:WS_MESSAGE.GHOST_SNAPSHOT,zone:sourceZone,players:visible,serverNow:Date.now()});
  }

  receive(snapshot) {
    if (!this.storeSnapshot(snapshot)) return;
    const players=Date.now()-snapshot.serverNow<=4*BORDER_SNAPSHOT_INTERVAL_MS ? snapshot.players : [];
    for (const ws of this.room.sockets())
      this.project(ws,this.room.player(ws),snapshot.sourceZone,players,snapshot.serverNow);
  }

  async initial(ws,p) {
    const currentZone=this.room.currentZoneId();
    if (!currentZone || !this.room.activePlayer(p)) return;
    const zones=await this.activeAdjacentZones();
    await Promise.allSettled(zones.map(async zoneId=>{
      const response=await this.room.env.ZONE.getByName(`free-zone-${zoneId}`).fetch(
        new Request(`https://zone.internal/_internal/border-state?destination=${encodeURIComponent(currentZone)}`));
      if (!response.ok) return;
      const state=await response.json();
      const snapshot=this.normalizeSnapshot({...state,sourceZone:zoneId});
      if (snapshot.error || !this.storeSnapshot(snapshot)) return;
      const players=Date.now()-snapshot.serverNow<=4*BORDER_SNAPSHOT_INTERVAL_MS ? snapshot.players : [];
      this.project(ws,this.room.player(ws),zoneId,players,snapshot.serverNow);
    }));
  }

  async refresh(ws) {
    let active;
    try { active=new Set(await this.activeAdjacentZones()); }
    catch (_) { active=new Set(); }
    const now=Date.now();
    for (const row of this.sql.exec('SELECT * FROM voxel_border_snapshots').toArray()) {
      const fresh=active.has(row.source_zone) && now-Number(row.received_at)<=4*BORDER_SNAPSHOT_INTERVAL_MS;
      const players=fresh ? JSON.parse(row.players) : [];
      this.project(ws,this.room.player(ws),row.source_zone,players,now);
    }
  }

  local(ws,p,moving=false) {
    if (!ws || !this.room.activePlayer(p)) return;
    const previous=new Set(p.localVisible||[]);
    const next=[];
    const maxD2=PLAYER_VISIBILITY_RADIUS**2;
    for (const otherWs of this.room.sockets()) {
      if (otherWs===ws) continue;
      const other=this.room.player(otherWs);
      if (!this.room.activePlayer(other)) continue;
      const otherPrevious=new Set(other.localVisible||[]);
      const visible=(other.x-p.x)**2+(other.z-p.z)**2<=maxD2;
      if (visible) {
        next.push(other.id);
        if (!previous.has(other.id)) this.room.send(ws,{type:WS_MESSAGE.JOIN,player:this.room.publicPlayer(other),count:this.room.count()});
        if (!otherPrevious.has(p.id)) {
          otherPrevious.add(p.id);
          this.room.send(otherWs,{type:WS_MESSAGE.JOIN,player:this.room.publicPlayer(p),count:this.room.count()});
        }
        if (moving) this.room.send(otherWs,{type:WS_MESSAGE.MOVE,player:this.room.publicPlayer(p)});
      } else if (otherPrevious.delete(p.id)) this.room.send(otherWs,{type:WS_MESSAGE.LEAVE,id:p.id,count:this.room.count()});
      if (JSON.stringify(other.localVisible||[])!==JSON.stringify([...otherPrevious])) {
        other.localVisible=[...otherPrevious];
        otherWs.serializeAttachment(other);
      }
    }
    for (const id of previous) if (!next.includes(id))
      this.room.send(ws,{type:WS_MESSAGE.LEAVE,id,count:this.room.count()});
    p.localVisible=next;
    ws.serializeAttachment(p);
  }

  leave(p,except) {
    const maxD2=PLAYER_VISIBILITY_RADIUS**2;
    for (const ws of this.room.sockets()) {
      if (ws===except) continue;
      const other=this.room.player(ws);
      if (!this.room.activePlayer(other)) continue;
      const previous=new Set(other.localVisible||[]);
      const wasVisible=previous.delete(p.id);
      if (wasVisible || (other.x-p.x)**2+(other.z-p.z)**2<=maxD2)
        this.room.send(ws,{type:WS_MESSAGE.LEAVE,id:p.id,count:this.room.count()});
      if (wasVisible) { other.localVisible=[...previous]; ws.serializeAttachment(other); }
    }
  }
}
