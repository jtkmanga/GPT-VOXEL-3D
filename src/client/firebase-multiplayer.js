        // FIREBASE REALTIME DATABASE LEADERBOARD & MULTIPLAYER SYSTEM
        let currentLeaderboardRef = null;

        // AOI (Area Of Interest) / Spatial Zones
        // The player never sees or selects a Zone. The client automatically
        // calculates its Zone and listens only to nearby Zones.
        const AOI_GRID_SIZE = 15;
        const AOI_ZONE_SIZE = 100; // MAP_SIZE 1500 / 15 Zones = 100 units per Zone
        const AOI_LISTEN_RADIUS = 1; // 3x3 Zones around the current Zone

        let currentPlayerZoneId = null;
        let currentZonePlayerRef = null;
        const remotePlayersRefs = {};
        const otherPlayers = {};

        function getPlayerZoneId(x, z) {
            const half = MAP_SIZE / 2;
            const col = Math.max(0, Math.min(
                AOI_GRID_SIZE - 1,
                Math.floor((x + half) / AOI_ZONE_SIZE)
            ));
            const row = Math.max(0, Math.min(
                AOI_GRID_SIZE - 1,
                Math.floor((z + half) / AOI_ZONE_SIZE)
            ));
            return `z_${row}_${col}`;
        }

        function getNearbyZoneIds(zoneId, radius = AOI_LISTEN_RADIUS) {
            const match = /^z_(\d+)_(\d+)$/.exec(zoneId || "");
            if (!match) return [];

            const row = Number(match[1]);
            const col = Number(match[2]);
            const zones = [];

            for (let r = row - radius; r <= row + radius; r++) {
                for (let c = col - radius; c <= col + radius; c++) {
                    if (
                        r >= 0 && r < AOI_GRID_SIZE &&
                        c >= 0 && c < AOI_GRID_SIZE
                    ) {
                        zones.push(`z_${r}_${c}`);
                    }
                }
            }
            return zones;
        }

        function removeAllAOIListeners() {
            Object.keys(remotePlayersRefs).forEach(zoneId => {
                const ref = remotePlayersRefs[zoneId];
                if (ref) ref.off();
                delete remotePlayersRefs[zoneId];
            });
            currentZonePlayerRef = null;
            currentPlayerZoneId = null;
            removeAllOtherPlayers();
        }

        function listenToRemotePlayers(serverId, force = false) {
            if (!serverId || !state.isPlaying) return;

            const myId = getMyPlayerId();
            const nextZoneId = getPlayerZoneId(playerPos.x, playerPos.z);

            if (!force && nextZoneId === currentPlayerZoneId && Object.keys(remotePlayersRefs).length) {
                return;
            }

            // Player crossed a Zone boundary: stop listening to the old AOI,
            // clear stale remote players, then subscribe to the new nearby Zones.
            removeAllAOIListeners();
            currentPlayerZoneId = nextZoneId;

            const nearbyZones = getNearbyZoneIds(nextZoneId);

            nearbyZones.forEach(zoneId => {
                const ref = database.ref(`servers/${serverId}/zones/${zoneId}/players`);
                remotePlayersRefs[zoneId] = ref;

                ref.on('child_added', snapshot => {
                    const pId = snapshot.key;
                    if (pId === myId) return;
                    addOtherPlayer(pId, snapshot.val());
                });

                ref.on('child_changed', snapshot => {
                    const pId = snapshot.key;
                    if (pId === myId) return;
                    updateOtherPlayer(pId, snapshot.val());
                });

                ref.on('child_removed', snapshot => {
                    const pId = snapshot.key;
                    if (pId === myId) return;
                    removeOtherPlayer(pId);
                });
            });

            // Keep a direct reference to the player's current Zone.
            currentZonePlayerRef = database.ref(
                `servers/${serverId}/zones/${currentPlayerZoneId}/players/${myId}`
            );
        }

        function listenToRealtimeLeaderboard(serverId) {
            if (!serverId) return;

            if (currentLeaderboardRef) {
                currentLeaderboardRef.off();
            }

            currentLeaderboardRef = database.ref(`servers/${serverId}/leaderboard`).orderByChild('score').limitToLast(20);

            currentLeaderboardRef.on('value', (snapshot) => {
                const board = [];
                snapshot.forEach((child) => {
                    board.push(child.val());
                });
                board.reverse();
                updateLeaderboardUI(board);
            }, (error) => {
                console.error("Database Read Error:", error);
            });
        }

        // 🌐 MULTIPLAYER: Real-time Player Position & Score Synchronization
        let lastSyncTime = 0;
        function syncMyPlayerData(force = false) {
            if (!state.isPlaying || !state.selectedServerId) return;

            const myId = getMyPlayerId();
            const now = Date.now();
            const nextZoneId = getPlayerZoneId(playerPos.x, playerPos.z);

            // Automatically move the player's database record to the new Zone.
            if (nextZoneId !== currentPlayerZoneId) {
                const oldZoneId = currentPlayerZoneId;
                const oldRef = oldZoneId
                    ? database.ref(`servers/${state.selectedServerId}/zones/${oldZoneId}/players/${myId}`)
                    : null;

                if (oldRef) {
                    oldRef.onDisconnect().cancel();
                    oldRef.remove().catch(err => console.warn("AOI old-zone cleanup:", err));
                }

                currentPlayerZoneId = nextZoneId;
                currentZonePlayerRef = database.ref(
                    `servers/${state.selectedServerId}/zones/${nextZoneId}/players/${myId}`
                );

                currentZonePlayerRef.onDisconnect().remove();
                listenToRemotePlayers(state.selectedServerId, true);
                force = true;
            }

            if (force || now - lastSyncTime > 70) {
                lastSyncTime = now;

                if (!currentZonePlayerRef) {
                    currentZonePlayerRef = database.ref(
                        `servers/${state.selectedServerId}/zones/${currentPlayerZoneId}/players/${myId}`
                    );
                    currentZonePlayerRef.onDisconnect().remove();
                }

                currentZonePlayerRef.set({
                    name: state.playerName,
                    x: Math.round(playerPos.x * 100) / 100,
                    y: Math.round(playerPos.y * 100) / 100,
                    z: Math.round(playerPos.z * 100) / 100,
                    rotY: Math.round(playerRotation * 100) / 100,
                    score: state.score,
                    zoneId: currentPlayerZoneId,
                    updatedAt: firebase.database.ServerValue.TIMESTAMP
                });

                if (state.score >= 0) {
                    database.ref(`servers/${state.selectedServerId}/leaderboard/${myId}`).set({
                        name: state.playerName,
                        score: state.score,
                        timestamp: Date.now()
                    });
                }
            }
        }

        function addOtherPlayer(id, data) {
            if (otherPlayers[id]) return;

            const pGroup = new THREE.Group();
            const skinMat = new THREE.MeshLambertMaterial({ color: 0xffdbac });
            const shirtMat = new THREE.MeshLambertMaterial({ color: 0xe53e3e });
            const pantsMat = new THREE.MeshLambertMaterial({ color: 0x742a2a });

            const head = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.9, 0.9), skinMat);
            head.position.y = 1.85;
            head.castShadow = true;
            pGroup.add(head);

            const eyeMat = new THREE.MeshBasicMaterial({ color: 0x1a202c });
            const leftEye = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.15, 0.05), eyeMat);
            leftEye.position.set(-0.2, 1.9, 0.46);
            pGroup.add(leftEye);

            const rightEye = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.15, 0.05), eyeMat);
            rightEye.position.set(0.2, 1.9, 0.46);
            pGroup.add(rightEye);

            const body = new THREE.Mesh(new THREE.BoxGeometry(1.0, 1.1, 0.6), shirtMat);
            body.position.y = 1.05;
            body.castShadow = true;
            pGroup.add(body);

            const oLeftArm = new THREE.Mesh(new THREE.BoxGeometry(0.35, 1.0, 0.35), skinMat);
            oLeftArm.position.set(-0.7, 1.0, 0);
            oLeftArm.castShadow = true;
            pGroup.add(oLeftArm);

            const oRightArm = new THREE.Mesh(new THREE.BoxGeometry(0.35, 1.0, 0.35), skinMat);
            oRightArm.position.set(0.7, 1.0, 0);
            oRightArm.castShadow = true;
            pGroup.add(oRightArm);

            const oLeftLeg = new THREE.Mesh(new THREE.BoxGeometry(0.42, 1.0, 0.42), pantsMat);
            oLeftLeg.position.set(-0.25, 0.5, 0);
            oLeftLeg.castShadow = true;
            pGroup.add(oLeftLeg);

            const oRightLeg = new THREE.Mesh(new THREE.BoxGeometry(0.42, 1.0, 0.42), pantsMat);
            oRightLeg.position.set(0.25, 0.5, 0);
            oRightLeg.castShadow = true;
            pGroup.add(oRightLeg);

            const initialPos = new THREE.Vector3(data.x || 0, data.y || 0, data.z || 0);
            pGroup.position.copy(initialPos);
            pGroup.rotation.y = data.rotY || 0;
            scene.add(pGroup);

            // Create 3D Name Tag Element for other online player
            const tag = document.createElement('div');
            tag.className = 'name-tag remote-name-tag';
            tag.id = `nametag-${id}`;
            const safeName = escapeHtml(data.name || 'Player');
            tag.innerHTML = `<span>${safeName}</span>`;
            document.body.appendChild(tag);

            otherPlayers[id] = {
                mesh: pGroup,
                nameTagEl: tag,
                targetPos: initialPos.clone(),
                targetRot: data.rotY || 0,
                walkCycle: 0,
                leftArm: oLeftArm,
                rightArm: oRightArm,
                leftLeg: oLeftLeg,
                rightLeg: oRightLeg,
                name: data.name || 'Player',
                _secureLastSeenAt: performance.now()
            };
        }

        function updateOtherPlayer(id, data) {
            const p = otherPlayers[id];
            if (!p) return;
            p.targetPos.set(data.x || 0, data.y || 0, data.z || 0);
            p.targetRot = data.rotY || 0;
            p._secureLastSeenAt = performance.now();
            if (data.name && p.name !== data.name) {
                p.name = data.name;
                const label = p.nameTagEl.querySelector('span');
                if (label) label.innerText = data.name;
            }
        }

        function removeOtherPlayer(id) {
            const p = otherPlayers[id];
            if (!p) return;
            scene.remove(p.mesh);
            if (p.nameTagEl && p.nameTagEl.parentNode) {
                p.nameTagEl.parentNode.removeChild(p.nameTagEl);
            }
            delete otherPlayers[id];
        }

        function removeAllOtherPlayers() {
            Object.keys(otherPlayers).forEach(id => removeOtherPlayer(id));
        }

        function escapeHtml(str) {
            return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        }

        function updateLeaderboardUI(board = []) {
            const miniList = document.getElementById('mini-leaderboard-list');
            miniList.innerHTML = '';

            if (board.length === 0) {
                miniList.innerHTML = '<div class="text-center text-slate-400 py-1">ยังไม่มีข้อมูล</div>';
            }

            board.slice(0, 5).forEach((item, index) => {
                const rankColor = index === 0 ? 'text-amber-400 font-extrabold' : (index === 1 ? 'text-slate-300 font-bold' : (index === 2 ? 'text-amber-600 font-bold' : 'text-slate-400'));
                const div = document.createElement('div');
                div.className = 'flex items-center justify-between';
                div.innerHTML = `
                    <div class="flex items-center gap-1.5 truncate">
                        <span class="w-4 text-[11px] ${rankColor}">${index + 1}.</span>
                        <span class="truncate font-semibold text-slate-200">${escapeHtml(item.name)}</span>
                    </div>
                    <span class="font-bold ${rankColor} ml-2">${item.score.toLocaleString()}</span>
                `;
                miniList.appendChild(div);
            });

            const fullList = document.getElementById('full-leaderboard-list');
            fullList.innerHTML = '';

            if (board.length === 0) {
                fullList.innerHTML = '<div class="text-center text-slate-400 py-4">ยังไม่มีข้อมูลอันดับ</div>';
            }

            board.forEach((item, index) => {
                const isTop3 = index < 3;
                const bg = isTop3 ? 'bg-amber-500/10 border-amber-500/30' : 'bg-slate-800/60 border-slate-700/50';
                const div = document.createElement('div');
                div.className = `flex items-center justify-between p-3 rounded-xl border ${bg}`;
                div.innerHTML = `
                    <div class="flex items-center gap-3">
                        <div class="w-7 h-7 rounded-full bg-slate-700 flex items-center justify-center font-extrabold text-xs ${index===0?'text-amber-400':(index===1?'text-slate-300':(index===2?'text-amber-600':'text-slate-400'))}">
                            ${index + 1}
                        </div>
                        <span class="font-bold text-white">${escapeHtml(item.name)}</span>
                    </div>
                    <span class="font-extrabold text-amber-400">${item.score.toLocaleString()} pts</span>
                `;
                fullList.appendChild(div);
            });
        }
