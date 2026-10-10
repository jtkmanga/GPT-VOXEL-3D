        function secureReturnToMenu() {
            state.isPlaying = false;
            state.isPaused = false;
            secureGameReady = false;
            secureHandoffInProgress = false;
            if (secureHandoffResumeTimer) clearTimeout(secureHandoffResumeTimer);
            secureHandoffResumeTimer = null;
            secureHandoffResumeResolve = null;
            secureHandoffResumeReject = null;
            secureCurrentZoneId = null;
            secureClearRemoteState();
            document.getElementById('exit-modal').classList.add('hidden');
            document.getElementById('game-hud').classList.add('hidden');
            document.getElementById('player-nametag').classList.add('hidden');
            document.getElementById('start-screen').classList.remove('hidden');
        }

        removeAllAOIListeners = function() {
            secureClearRemoteState();
            currentZonePlayerRef = null;
            currentPlayerZoneId = null;
        };

        listenToRemotePlayers = function() {
            // Remote players arrive through Worker WebSocket broadcasts.
        };

        listenToRealtimeLeaderboard = function() {
            // Leaderboard arrives through Worker WebSocket messages.
        };

        listenToCoinsRealtime = function() {
            // Coin state arrives through Worker WebSocket messages.
            coins.forEach(c => { c.active = false; c.mesh.visible = false; });
        };

        collectCoin = function(coin) {
            if (secureHandoffInProgress || !coin || !coin.active || !secureGameReady || !secureGameSocket || secureGameSocket.readyState !== WebSocket.OPEN) return;
            const id = Number(coin.serverId);
            if (!Number.isInteger(id)) return;

            const now = Date.now();
            if (Number(coin._collectPendingUntil || 0) > now) return;

            // Immediate visual prediction: hide on contact, but score remains
            // server-authoritative. If the server rejects/times out, restore it.
            const requestId = Number(coin._collectRequestId || 0) + 1;
            coin._collectRequestId = requestId;
            coin._collectPendingUntil = now + 2500;
            coin.active = false;
            coin.mesh.visible = false;

            try {
                secureGameSocket.send(JSON.stringify({
                    type: protocol.WS_MESSAGE.COLLECT,
                    id,
                    x: Math.round(playerPos.x * 100) / 100,
                    y: Math.round(playerPos.y * 100) / 100,
                    z: Math.round(playerPos.z * 100) / 100,
                    r: Math.round(playerRotation * 1000) / 1000
                }));
            } catch (_) {
                coin._collectPendingUntil = 0;
                coin.active = true;
                coin.mesh.visible = true;
                return;
            }

            setTimeout(() => {
                if (
                    coin._collectRequestId === requestId &&
                    Number(coin._collectPendingUntil || 0) > 0
                ) {
                    coin._collectPendingUntil = 0;
                    coin.active = true;
                    coin.mesh.visible = true;
                }
            }, 2700);
        };

        syncMyPlayerData = function(force = false) {
            if (!state.isPlaying || secureHandoffInProgress || !secureGameReady || !secureGameSocket || secureGameSocket.readyState !== WebSocket.OPEN) return;
            const now = Date.now();
            if (!force && now - secureLastMoveSentAt < config.MOVE_TICK_MS) return; // FREE_10K_PHASE1_CLIENT: 5Hz
            secureLastMoveSentAt = now;

            const positionZone = secureZoneFromPosition(playerPos.x, playerPos.z);
            if (positionZone && positionZone === secureCurrentZoneId) {
                secureRememberStablePosition();
            }

            secureGameSocket.send(JSON.stringify({
                type: protocol.WS_MESSAGE.MOVE,
                x: Math.round(playerPos.x * 100) / 100,
                y: Math.round(playerPos.y * 100) / 100,
                z: Math.round(playerPos.z * 100) / 100,
                r: Math.round(playerRotation * 1000) / 1000
            }));
        };

        // Lucky Box is fully server-authoritative in this build.
        // The Worker owns: one-box state, claim locking, 4-hour respawn and reward RNG.
        function secureApplyLuckyBoxState(raw = null, serverNow = null) {
            if (serverNow) secureSetServerNow(serverNow);
            if (!raw || typeof raw !== 'object') return;

            if (!luckyBox || !luckyBox.mesh) {
                const chestMesh = createTreasureChest();
                chestMesh.visible = false;
                scene.add(chestMesh);
                luckyBox = {
                    mesh: chestMesh,
                    active: false,
                    baseY: 0,
                    nextSpawnTimestamp: 0,
                    spawnCycle: 0,
                    collecting: false,
                    claimExpiresAt: 0,
                    claimed: false
                };
            }

            luckyBox.nextSpawnTimestamp = Number(raw.nextSpawnAt ?? raw.nextSpawnTimestamp ?? 0) || 0;
            luckyBox.spawnCycle = Number(raw.cycle ?? raw.spawnCycle ?? 0) || 0;
            luckyBox.claimExpiresAt = Number(raw.claimExpiresAt ?? 0) || 0;
            luckyBox.claimed = Boolean(raw.claimed);
            luckyBox.collecting = false;

            const x = Number(raw.x);
            const z = Number(raw.z);
            if (Number.isFinite(x) && Number.isFinite(z)) {
                luckyBox.mesh.position.set(x, 0, z);
            }

            const now = secureNow();
            const claimStillActive = luckyBox.claimed && luckyBox.claimExpiresAt > now;
            const waitingRespawn = luckyBox.nextSpawnTimestamp > now;
            luckyBox.active = Boolean(raw.active) && !claimStillActive && !waitingRespawn;
            luckyBox.mesh.visible = luckyBox.active;
            secureUpdateLuckyBoxTimer();
        }

        function secureUpdateLuckyBoxTimer() {
            const timerEl = document.getElementById('hud-box-timer');
            if (!timerEl || !luckyBox) return;

            const now = secureNow();

            // A claim has a short timeout. If the winner closes the page before spinning,
            // the same global box becomes available again automatically.
            if (luckyBox.claimed && luckyBox.claimExpiresAt > now) {
                timerEl.innerText = 'มีผู้เล่นกำลังสุ่ม...';
                luckyBox.active = false;
                if (luckyBox.mesh) luckyBox.mesh.visible = false;
                return;
            }

            if (luckyBox.nextSpawnTimestamp > now) {
                const totalSec = Math.max(0, Math.ceil((luckyBox.nextSpawnTimestamp - now) / 1000));
                const hours = Math.floor(totalSec / 3600);
                const minutes = Math.floor((totalSec % 3600) / 60);
                const seconds = totalSec % 60;
                timerEl.innerText = `${String(hours).padStart(2,'0')}:${String(minutes).padStart(2,'0')}:${String(seconds).padStart(2,'0')}`;
                luckyBox.active = false;
                if (luckyBox.mesh) luckyBox.mesh.visible = false;
                return;
            }

            luckyBox.claimed = false;
            luckyBox.active = true;
            if (luckyBox.mesh) luckyBox.mesh.visible = true;
            timerEl.innerText = 'พร้อมเปิด!';
        }

        function secureRequestLuckyBoxCollect() {
            if (secureHandoffInProgress || !luckyBox || !luckyBox.active || luckyBox.collecting) return;
            if (!secureGameReady || !secureGameSocket || secureGameSocket.readyState !== WebSocket.OPEN) return;
            luckyBox.collecting = true;
            setTimeout(() => { if (luckyBox) luckyBox.collecting = false; }, 1200);
            secureGameSocket.send(JSON.stringify({ type: protocol.WS_MESSAGE.COLLECT_BOX }));
        }

        spawnLuckyBoxes = function() {
            if (luckyBox?.mesh && scene) scene.remove(luckyBox.mesh);
            const chestMesh = createTreasureChest();
            chestMesh.visible = false;
            scene.add(chestMesh);
            luckyBox = {
                mesh: chestMesh,
                active: false,
                baseY: 0,
                nextSpawnTimestamp: 0,
                spawnCycle: 0,
                collecting: false,
                claimExpiresAt: 0,
                claimed: false
            };
            luckyBoxServerRef = null;
            const timerEl = document.getElementById('hud-box-timer');
            if (timerEl) timerEl.innerText = 'กำลังโหลดจาก Server...';
        };

        triggerLuckyBoxModal = function() {
            state.isPaused = true;
            const localNameTag = document.getElementById('player-nametag');
            if (localNameTag) localNameTag.style.display = 'none';
            state.wheelSpinning = false;
            state.wheelReward = null;
            document.getElementById('wheel-modal').classList.remove('hidden');
            document.getElementById('btn-spin-wheel').classList.remove('hidden');
            document.getElementById('btn-close-wheel').classList.add('hidden');
            document.getElementById('wheel-result-msg').innerText = 'กดปุ่มเพื่อเริ่มหมุนวงล้อ!';
            drawLuckyWheel();
            audio.playBoxHit();
        };

        spinWheel = function() {
            if (state.wheelSpinning || secureHandoffInProgress) return;
            if (!secureGameReady || !secureGameSocket || secureGameSocket.readyState !== WebSocket.OPEN) {
                alert('Game Server หลุด กรุณาเข้าเกมใหม่');
                return;
            }
            state.wheelSpinning = true;
            document.getElementById('btn-spin-wheel').classList.add('hidden');
            document.getElementById('wheel-result-msg').innerText = 'กำลังขอผลสุ่มจาก Server...';
            secureGameSocket.send(JSON.stringify({ type: protocol.WS_MESSAGE.SPIN_BOX }));
        };
