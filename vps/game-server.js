const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const crypto = require('crypto');
const { verifyFirebaseIdToken } = require('./firebase-auth');
const gameDb = require('./game-db');

const {
  normalizeZoneId,
  zoneFromPosition,
  neighboringZones
} = require('./zones');

const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID;

if (!FIREBASE_PROJECT_ID) {
  console.error('ERROR: FIREBASE_PROJECT_ID is missing');
  process.exit(1);
}

const ENTITLEMENTS_BASE =
  process.env.ENTITLEMENTS_BASE ||
  'https://voxel-run-v2-demo.hjinffv5426.workers.dev';

async function loadEntitlements(token) {
  const response = await fetch(
    ENTITLEMENTS_BASE + '/entitlements',
    {
      method: 'GET',
      headers: {
        Authorization: 'Bearer ' + token
      },
      signal: AbortSignal.timeout(5000)
    }
  );

  const data = await response.json().catch(() => ({}));

  if (!response.ok || !data?.ok) {
    throw new Error(
      data?.error || 'Entitlement check failed'
    );
  }

  return data;
}

const PORT = Number(process.env.PORT || 8080);

// Phase 4A
// ยังเป็น server ทดสอบ ไม่แทน Cloudflare ตัวจริง
const SERVERS = {
  free1: {
    name: 'Free Server 1',
    maxPlayers: 1000,
    players: new Map()
  },
  vip1: {
    name: 'VIP Server 1',
    maxPlayers: 100,
    players: new Map()
  }
};

function getZoneRegistry(server) {
  if (!(server.zones instanceof Map)) {
    server.zones = new Map();
  }

  return server.zones;
}

function registerPlayerZone(
  server,
  player,
  requestedZone
) {
  const zoneId =
    normalizeZoneId(requestedZone);

  if (!zoneId) return false;

  const zones = getZoneRegistry(server);

  if (
    player.zoneId &&
    player.zoneId !== zoneId
  ) {
    const previous =
      zones.get(player.zoneId);

    if (previous) {
      previous.delete(player.id);

      if (previous.size === 0) {
        zones.delete(player.zoneId);
      }
    }
  }

  let members = zones.get(zoneId);

  if (!members) {
    members = new Set();
    zones.set(zoneId, members);
  }

  members.add(player.id);
  player.zoneId = zoneId;

  return true;
}

function removePlayerFromZone(
  server,
  player
) {
  if (!player?.zoneId) return;

  const zones = getZoneRegistry(server);
  const members =
    zones.get(player.zoneId);

  if (!members) return;

  members.delete(player.id);

  if (members.size === 0) {
    zones.delete(player.zoneId);
  }
}

function send(ws, data) {
  if (ws.readyState !== WebSocket.OPEN) return;

  try {
    ws.send(JSON.stringify(data));
  } catch (_) {}
}

function publicPlayer(player) {
  return {
    id: player.id,
    nickname: player.nickname,
    zone: player.zoneId,
    x: player.x,
    y: player.y,
    z: player.z,
    r: player.r
  };
}

function visiblePlayersFor(
  server,
  sourcePlayer
) {
  if (!sourcePlayer?.zoneId) {
    return [];
  }

  const allowedZones = new Set(
    neighboringZones(
      sourcePlayer.zoneId,
      1
    )
  );

  return [
    ...server.players.values()
  ]
    .filter(other =>
      other.id !== sourcePlayer.id &&
      other.authenticated === true &&
      other.zoneId &&
      allowedZones.has(other.zoneId)
    )
    .map(publicPlayer);
}

function sendVisibilitySnapshot(
  server,
  sourcePlayer,
  reason = 'sync'
) {
  if (!sourcePlayer?.authenticated) return;

  send(sourcePlayer.ws, {
    type: 'visibility_snapshot',
    zone: sourcePlayer.zoneId,
    reason,
    players: visiblePlayersFor(
      server,
      sourcePlayer
    ),
    count: server.players.size
  });
}

function reconcileZoneVisibility(
  server,
  movingPlayer,
  oldZoneId,
  newZoneId
) {
  if (
    !oldZoneId ||
    !newZoneId ||
    oldZoneId === newZoneId
  ) {
    return;
  }

  const oldVisibleZones = new Set(
    neighboringZones(oldZoneId, 1)
  );

  const newVisibleZones = new Set(
    neighboringZones(newZoneId, 1)
  );

  for (
    const other
    of server.players.values()
  ) {
    if (
      other.id === movingPlayer.id ||
      other.authenticated !== true ||
      !other.zoneId
    ) {
      continue;
    }

    const wasVisible =
      oldVisibleZones.has(
        other.zoneId
      );

    const isVisible =
      newVisibleZones.has(
        other.zoneId
      );

    if (wasVisible === isVisible) {
      continue;
    }

    if (isVisible) {
      // ผู้เล่นอื่นเริ่มเห็นคนที่กำลังข้าม Zone
      send(other.ws, {
        type: 'join',
        player:
          publicPlayer(movingPlayer),
        count: server.players.size
      });

      // คนที่กำลังข้าม Zone เริ่มเห็นผู้เล่นอื่น
      send(movingPlayer.ws, {
        type: 'join',
        player:
          publicPlayer(other),
        count: server.players.size
      });

      continue;
    }

    // ผู้เล่นอื่นต้องลบคนที่เดินออกจากระยะ
    send(other.ws, {
      type: 'leave',
      id: movingPlayer.id,
      count: server.players.size
    });

    // คนที่กำลังข้าม Zone ต้องลบผู้เล่นเก่า
    send(movingPlayer.ws, {
      type: 'leave',
      id: other.id,
      count: server.players.size
    });
  }
}

function broadcastNearby(
  server,
  sourcePlayer,
  data,
  except = null
) {
  if (!sourcePlayer?.zoneId) return;

  const allowedZones = new Set(
    neighboringZones(
      sourcePlayer.zoneId,
      1
    )
  );

  const message = JSON.stringify(data);

  for (const player of server.players.values()) {
    if (player.ws === except) continue;
    if (player.authenticated !== true) continue;
    if (!player.zoneId) continue;
    if (!allowedZones.has(player.zoneId)) continue;
    if (player.ws.readyState !== WebSocket.OPEN) continue;

    try {
      player.ws.send(message);
    } catch (_) {}
  }
}

function broadcast(server, data, except = null) {
  const message = JSON.stringify(data);

  for (const player of server.players.values()) {
    if (player.ws === except) continue;
    if (player.ws.readyState !== WebSocket.OPEN) continue;

    try {
      player.ws.send(message);
    } catch (_) {}
  }
}

const httpServer = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, {
      'content-type': 'text/plain; charset=utf-8'
    });

    res.end('VOXEL VPS Phase 4A online');
    return;
  }

  if (req.url === '/status') {
    const result = {};

    for (const [id, server] of Object.entries(SERVERS)) {
      result[id] = {
        name: server.name,
        players: server.players.size,
        maxPlayers: server.maxPlayers,
        activeZones:
          getZoneRegistry(server).size
      };
    }

    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8'
    });

    res.end(JSON.stringify(result));
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

const wss = new WebSocketServer({
  server: httpServer,
  path: '/play'
});

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');

  const serverId = url.searchParams.get('server') || 'free1';
  const gameServer = SERVERS[serverId];

  if (!gameServer) {
    ws.close(1008, 'Invalid server');
    return;
  }

  if (gameServer.players.size >= gameServer.maxPlayers) {
    ws.close(1013, 'Server full');
    return;
  }

  const player = {
    id: crypto.randomUUID(),
    nickname: 'Player',
    x: 0,
    y: 0,
    z: 0,
    r: 0,
    ws,
    serverId,
    zoneId: zoneFromPosition(0, 0),
    authenticated: false
  };

  ws.player = player;

  send(ws, {
    type: 'connected',
    phase: '4A',
    server: serverId,
    count: gameServer.players.size,
    maxPlayers: gameServer.maxPlayers
  });

  ws.on('message', async raw => {
    if (raw.length > 8192) {
      ws.close(1009, 'Message too large');
      return;
    }

    let msg;

    try {
      msg = JSON.parse(raw.toString());
    } catch (_) {
      return;
    }

    // Phase 4A.2 - Firebase Authentication
    if (msg.type === 'auth') {
      if (player.authenticated) return;

      player.authAttempts =
        (player.authAttempts || 0) + 1;

      if (player.authAttempts > 3) {
        ws.close(1008, 'Too many auth attempts');
        return;
      }

      let verified;

      try {
        verified = await verifyFirebaseIdToken(
          msg.token,
          FIREBASE_PROJECT_ID
        );
      } catch (_) {
        send(ws, {
          type: 'auth_error',
          message: 'Firebase sign-in failed'
        });

        ws.close(1008, 'Invalid Firebase ID token');
        return;
      }

      const nickname =
        String(msg.nickname || 'Player')
          .trim()
          .slice(0, 24) || 'Player';

      player.uid = verified.uid;
      player.tokenExpiresAt = verified.exp;
      player.nickname = nickname;

      let entitlementData = null;

      try {
        entitlementData = await loadEntitlements(msg.token);
      } catch (_) {
        send(ws, {
          type: 'auth_error',
          message: 'Unable to verify account access'
        });

        ws.close(1013, 'Entitlement service unavailable');
        return;
      }

      const vipExpires =
        Number(
          entitlementData?.entitlements?.vip1Expires
        ) || 0;

      const serverNow =
        Number(entitlementData?.serverNow) ||
        Date.now();

      const vipActive =
        entitlementData?.active?.vip1 === true &&
        vipExpires > serverNow;

      if (serverId === 'vip1' && !vipActive) {
        send(ws, {
          type: 'auth_error',
          code: 'VIP_REQUIRED',
          message: 'VIP access required'
        });

        ws.close(1008, 'VIP access required');
        return;
      }

      player.entitlements = entitlementData.entitlements || {};
      player.vipActive = vipActive;
      player.authenticated = true;

      const score = gameDb.ensurePlayer(
        serverId,
        player.uid,
        player.nickname
      );

      player.score = score;

      const leaderboard =
        gameDb.getLeaderboard(serverId);

      gameServer.players.set(player.id, player);

      registerPlayerZone(
        gameServer,
        player,
        player.zoneId ||
          zoneFromPosition(
            player.x,
            player.z
          )
      );

      send(ws, {
        type: 'welcome',
        phase: '4A.2',
        protocol: 4,
        id: player.id,
        nickname: player.nickname,
        server: serverId,
        spawn: {
          x: player.x,
          y: player.y,
          z: player.z
        },
        players:
          visiblePlayersFor(
            gameServer,
            player
          ),
        count: gameServer.players.size,
        maxPlayers: gameServer.maxPlayers,
        score,
        leaderboard
      });

      broadcastNearby(
        gameServer,
        player,
        {
          type: 'join',
          player: publicPlayer(player),
          count: gameServer.players.size
        },
        ws
      );

      return;
    }

    if (
      !player.authenticated ||
      !player.uid ||
      Math.floor(Date.now() / 1000) >= player.tokenExpiresAt
    ) {
      send(ws, {
        type: 'auth_error',
        message: 'Sign in required'
      });

      ws.close(1008, 'Authentication expired');
      return;
    }

    if (msg.type === 'move') {
      const x = Number(msg.x);
      const y = Number(msg.y);
      const z = Number(msg.z);
      const r = Number(msg.r);

      if (![x, y, z, r].every(Number.isFinite)) return;

      if (
        Math.abs(x) > 750 ||
        Math.abs(z) > 750 ||
        y < -25 ||
        y > 200
      ) {
        return;
      }

      player.x = x;
      player.y = y;
      player.z = z;
      player.r = r;

      const previousZoneId =
        player.zoneId;

      const nextZoneId =
        zoneFromPosition(x, z);

      if (!nextZoneId) {
        return;
      }

      registerPlayerZone(
        gameServer,
        player,
        nextZoneId
      );

      reconcileZoneVisibility(
        gameServer,
        player,
        previousZoneId,
        nextZoneId
      );

      if (
        previousZoneId &&
        nextZoneId !== previousZoneId
      ) {
        // Phase 4D.3E: VPS uses one socket for the whole session.
        // Tell the client which server-authoritative Zone it is now in,
        // then send a compact nearby snapshot to heal any brief join/leave race.
        send(ws, {
          type: 'zone_change',
          fromZone: previousZoneId,
          toZone: nextZoneId,
          zone: nextZoneId
        });

        sendVisibilitySnapshot(
          gameServer,
          player,
          'zone_change'
        );
      }

      broadcastNearby(
        gameServer,
        player,
        {
          type: 'move',
          player: publicPlayer(player)
        },
        ws
      );

      return;
    }

    send(ws, {
      type: 'phase4a_pending',
      feature: msg.type || 'unknown'
    });
  });

  ws.on('close', () => {
    if (!player.authenticated) return;

    removePlayerFromZone(
      gameServer,
      player
    );

    gameServer.players.delete(player.id);

    broadcastNearby(
      gameServer,
      player,
      {
        type: 'leave',
        id: player.id,
        count: gameServer.players.size
      }
    );
  });

  ws.on('error', () => {});
});

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log('====================================');
  console.log('VOXEL VPS Phase 4A');
  console.log(`HTTP/WebSocket port: ${PORT}`);
  console.log('Health: /health');
  console.log('WebSocket: /play?server=free1');
  console.log('Free Server 1: max 1000');
  console.log('VIP Server 1: max 100');
  console.log('====================================');
});
