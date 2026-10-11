        function securePlayerNameFromId(id) {
            const text = String(id || 'player');
            return 'Player-' + text.slice(-6);
        }

        function secureNormalizePlayer(p = {}) {
            return {
                id: String(p.id || ''),
                x: Number(p.x) || 0,
                y: Number(p.y) || 0,
                z: Number(p.z) || 0,
                rotY: Number(p.rotY ?? p.r) || 0,
                name: String(p.name || p.nickname || securePlayerNameFromId(p.id))
            };
        }

        function secureNormalizeZoneId(value) {
            const match = /^(\d{1,2}),(\d{1,2})$/.exec(String(value || ''));
            if (!match) return null;
            const zx = Number(match[1]);
            const zz = Number(match[2]);
            if (!Number.isInteger(zx) || !Number.isInteger(zz) ||
                zx < 0 || zz < 0 || zx >= SECURE_ZONE_GRID_SIZE || zz >= SECURE_ZONE_GRID_SIZE) {
                return null;
            }
            return `${zx},${zz}`;
        }

        function secureZoneFromPosition(x, z) {
            x = Number(x);
            z = Number(z);
            if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
            const half = MAP_SIZE / 2;
            if (x < -half || x >= half || z < -half || z >= half) return null;
            const zx = Math.min(SECURE_ZONE_GRID_SIZE - 1, Math.max(0, Math.floor((x + half) / SECURE_ZONE_SIZE)));
            const zz = Math.min(SECURE_ZONE_GRID_SIZE - 1, Math.max(0, Math.floor((z + half) / SECURE_ZONE_SIZE)));
            return `${zx},${zz}`;
        }

        function secureZoneSocketUrl(zoneId, serverId = state.selectedServerId || 'free1') {
            if (serverId === 'vip1') return `${SECURE_WORKER_WS_BASE}?server=vip1`;
            if (serverId !== 'free1') throw new Error('Server ไม่ถูกต้อง');
            const normalized = secureNormalizeZoneId(zoneId);
            if (!normalized) throw new Error('Zone ไม่ถูกต้อง');
            return `${SECURE_WORKER_WS_BASE}?zone=${encodeURIComponent(normalized)}`;
        }

        function secureRememberStablePosition() {
            secureLastStablePosition = {
                x: Number(playerPos.x) || 0,
                y: Number(playerPos.y) || 0,
                z: Number(playerPos.z) || 0,
                r: Number(playerRotation) || 0
            };
        }

        function secureClearRemoteState() {
            secureRemoteSources.clear();
            secureGhostMembersByZone.clear();
            removeAllOtherPlayers();
        }

        function secureDropRemoteSource(sourceKey) {
            [...secureRemoteSources.keys()].forEach(id => {
                secureUntrackRemotePlayer(id, sourceKey);
            });
        }

        function secureTrackRemotePlayer(id, sourceKey, rawPlayer) {
            id = String(id || '');
            if (!id || id === state.serverPlayerId) return;
            const p = secureNormalizePlayer(rawPlayer);
            if (!p.id) p.id = id;

            let sources = secureRemoteSources.get(id);
            if (!sources) {
                sources = new Set();
                secureRemoteSources.set(id, sources);
            }
            sources.add(sourceKey);

            if (!otherPlayers[id]) addOtherPlayer(id, p);
            else updateOtherPlayer(id, p);
        }

        function secureUntrackRemotePlayer(id, sourceKey) {
            id = String(id || '');
            const sources = secureRemoteSources.get(id);
            if (!sources) return;
            sources.delete(sourceKey);
            if (sources.size === 0) {
                secureRemoteSources.delete(id);
                removeOtherPlayer(id);
            }
        }

        function secureReplaceGhostSnapshot(message) {
            const zoneId = secureNormalizeZoneId(message?.zone);
            if (!zoneId) return;
            if (message?.serverNow) secureSetServerNow(message.serverNow);

            const sourceKey = `ghost:${zoneId}`;
            const previous = secureGhostMembersByZone.get(zoneId) || new Set();
            const next = new Set();

            (Array.isArray(message?.players) ? message.players : []).forEach(raw => {
                const p = secureNormalizePlayer(raw);
                if (!p.id || p.id === state.serverPlayerId) return;
                next.add(p.id);
                secureTrackRemotePlayer(p.id, sourceKey, p);
            });

            previous.forEach(id => {
                if (!next.has(id)) secureUntrackRemotePlayer(id, sourceKey);
            });
            secureGhostMembersByZone.set(zoneId, next);
        }

        function secureCloseSocket(ws, code = 1000, reason = 'Bye') {
            if (!ws) return;
            secureIntentionalSockets.add(ws);
            try { ws.close(code, reason); } catch (_) {}
        }

        function secureNormalizeLeaderboard(top = []) {
            return Array.isArray(top) ? top.map(row => ({
                name: String(row?.name || row?.nickname || 'Player'),
                score: Number(row?.score) || 0
            })) : [];
        }

        function secureApplyCoinSnapshot(serverCoins = [], serverNow = null) {
            if (serverNow) secureSetServerNow(serverNow);
            const now = serverNow ? Number(serverNow) : secureNow();
            const entries = new Map();
            if (Array.isArray(serverCoins)) serverCoins.forEach(data => {
                const id = Number(data?.id);
                if (!Number.isInteger(id) || id < 0 || id >= coins.length) return;
                entries.set(id, data);
            });

            coins.forEach((coin, id) => {
                const data = entries.get(id);
                if (!data) {
                    coin.serverId = null;
                    coin.active = false;
                    coin.mesh.visible = false;
                    return;
                }
                const cycle = Number(data.cycle) || 0;
                if (Number.isSafeInteger(coin.serverCycle) && cycle < coin.serverCycle) return;
                if (coin.serverCycle !== cycle) coin._collectActionRequestId = null;
                coin.serverCycle = cycle;
                coin._collectPendingUntil = 0;
                coin.serverId = id;
                coin.id = `server_coin_${id}`;
                coin.mesh.position.x = Number(data.x) || 0;
                coin.mesh.position.z = Number(data.z) || 0;
                coin.mesh.position.y = coin.baseY;
                coin.respawnTime = Number(data.respawnAt) || 0;
                coin.active = coin.respawnTime <= now;
                coin.mesh.visible = coin.active;
            });
        }

        function secureUpdateCoinState(message) {
            const id = Number(message?.id);
            if (!Number.isInteger(id) || id < 0 || id >= coins.length) return;
            const coin = coins[id];
            if (message?.requestId && coin._collectActionRequestId &&
                message.requestId !== coin._collectActionRequestId &&
                Number(coin._collectPendingUntil || 0) > 0) return;
            const cycle = Number(message?.cycle);
            if (Number.isSafeInteger(cycle) && cycle >= 0) {
                if (Number.isSafeInteger(coin.serverCycle) && cycle < coin.serverCycle) return;
                if (coin.serverCycle !== cycle) coin._collectActionRequestId = null;
                coin.serverCycle = cycle;
            }
            if (message?.serverNow) secureSetServerNow(message.serverNow);
            if (message?.type === protocol.WS_MESSAGE.COIN_STATE &&
                message.requestId === coin._collectActionRequestId) coin._collectActionRequestId = null;
            coin.serverId = id;
            if (Number.isFinite(Number(message?.x)) && Number.isFinite(Number(message?.z))) {
                coin.mesh.position.x = Number(message.x);
                coin.mesh.position.z = Number(message.z);
                coin.mesh.position.y = coin.baseY;
            }
            coin.respawnTime = Number(message?.respawnAt) || 0;
            coin._collectPendingUntil = 0;
            coin.active = coin.respawnTime <= secureNow();
            coin.mesh.visible = coin.active;
        }
