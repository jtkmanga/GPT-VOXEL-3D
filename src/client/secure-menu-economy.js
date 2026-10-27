        function clearLuckyBoxMesh() {
            const mesh = luckyBox && luckyBox.mesh;
            if (!mesh) { luckyBox = null; return; }
            if (scene) scene.remove(mesh);
            const geometries = new Set(), materials = new Set();
            mesh.traverse(obj => {
                if (obj.geometry) geometries.add(obj.geometry);
                const list = Array.isArray(obj.material) ? obj.material : [obj.material];
                list.forEach(material => { if (material) materials.add(material); });
            });
            if (scene) scene.traverse(obj => {
                geometries.delete(obj.geometry);
                const list = Array.isArray(obj.material) ? obj.material : [obj.material];
                list.forEach(material => materials.delete(material));
            });
            geometries.forEach(geometry => geometry.dispose());
            materials.forEach(material => material.dispose());
            luckyBox = null;
        }

        function secureReturnToMenu() {
            state.wheelAnimation = null;
            state.wheelSpinning = false;
            state.wheelReward = null;
            document.getElementById('wheel-modal').classList.add('hidden');
            if (typeof window !== 'undefined' && typeof window.resetGameplayInput === 'function') window.resetGameplayInput();
            if (typeof secureAbortClientConnections === 'function') secureAbortClientConnections('Returned to menu');
            clearLuckyBoxMesh();
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
            document.getElementById('shop-modal').classList.add('hidden');
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

        let secureEconomyRequestCounter = 0;

        function secureEconomyRequestId(kind) {
            const nonce = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
                ? crypto.randomUUID()
                : `${Date.now().toString(36)}-${(++secureEconomyRequestCounter).toString(36)}-${Math.random().toString(36).slice(2)}`;
            return `${kind}:${nonce}`;
        }

        collectCoin = function(coin) {
            const socket = typeof secureHandoffEconomySocket === 'function' ? secureHandoffEconomySocket() : secureGameSocket;
            if ((secureHandoffInProgress && !(typeof secureHandoffEconomySocket === 'function' && socket)) ||
                !coin || !coin.active || !secureGameReady || !socket || socket.readyState !== WebSocket.OPEN) return;
            const id = Number(coin.serverId);
            if (!Number.isInteger(id)) return;

            const now = Date.now();
            if (Number(coin._collectPendingUntil || 0) > now || Number(coin._collectRetryAt || 0) > now) return;

            // Ordered movement frames reach authority before contact. The
            // pickup still contains no client position, distance or score.
            if (typeof secureFlushMovementForPickup === 'function' && secureFlushMovementForPickup() === false) return;

            // Immediate visual prediction: hide on contact, but score remains
            // server-authoritative. If the server rejects/times out, restore it.
            const requestId = Number(coin._collectRequestId || 0) + 1;
            coin._collectRequestId = requestId;
            const uid = String(auth.currentUser?.uid || '');
            if (!coin._collectActionRequestId || coin._collectActionUid !== uid) {
                coin._collectActionRequestId = secureEconomyRequestId('coin');
                coin._collectActionUid = uid;
            }
            coin._collectPendingUntil = now + 2500;
            coin.active = false;
            coin.mesh.visible = false;

            try {
                socket.send(JSON.stringify({
                    type: protocol.WS_MESSAGE.COLLECT,
                    id,
                    requestId: coin._collectActionRequestId
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
            if (!state.isPlaying || secureHandoffInProgress || !secureGameReady ||
                !secureGameSocket || secureGameSocket.readyState !== WebSocket.OPEN) return false;
            const now = Date.now();
            if (!force && now - secureLastMoveSentAt < config.MOVE_TICK_MS) return false;
            const input = state.isPaused ? { x: 0, z: 0, jump: false } : secureMovementIntent();
            const predicted = typeof secureUnsentMovementFrames === 'function' ? secureUnsentMovementFrames() : [];
            const frames = predicted.length
                ? predicted.map(frame => ({ input: { ...frame.input }, delta: frame.delta }))
                : [{ input, delta: 0 }];
            if (!movement.validMovementFrames(frames)) return false;

            const seq = secureInputSequence;
            try {
                secureGameSocket.send(JSON.stringify({
                    type: protocol.WS_MESSAGE.MOVE,
                    input,
                    seq,
                    frames
                }));
            } catch (_) {
                return false;
            }
            secureInputSequence++;
            secureLastMoveSentAt = now;
            securePendingInputs.push({ seq, input, jumpGeneration: secureJumpGeneration });
            if (securePendingInputs.length > 64) securePendingInputs.shift();
            return true;
        };

        function secureFlushMovementForPickup() {
            if (!state.isPlaying || !secureGameReady || secureHandoffInProgress ||
                !secureGameSocket || secureGameSocket.readyState !== WebSocket.OPEN) return false;
            return (typeof secureUnsentMovementFrames !== 'function' || secureUnsentMovementFrames().length === 0)
                || syncMyPlayerData(true);
        }

        // Lucky Box is fully server-authoritative in this build.
        // The Worker owns: one-box state, claim locking, 4-hour respawn and reward RNG.
        function secureApplyLuckyBoxState(raw = null, serverNow = null) {
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
                    claimed: false,
                    serverActive: false
                };
            }

            const cycle = Number(raw.cycle ?? raw.spawnCycle ?? 0) || 0;
            if (cycle < luckyBox.spawnCycle) return;
            const packetAt = Number(serverNow);
            if (cycle === luckyBox.spawnCycle && Number.isFinite(packetAt) && packetAt > 0 &&
                packetAt < Number(luckyBox._snapshotServerNow || 0)) return;
            const nextSpawnTimestamp = Number(raw.nextSpawnAt ?? raw.nextSpawnTimestamp ?? 0) || 0;
            // A collection fixes one deadline for this resource cycle. Check
            // against the current trusted clock before applying packet time:
            // an old snapshot cannot erase or extend an ongoing cooldown.
            if (cycle === luckyBox.spawnCycle && luckyBox.nextSpawnTimestamp > secureNow() &&
                nextSpawnTimestamp !== luckyBox.nextSpawnTimestamp) return;
            if (Number.isFinite(packetAt) && packetAt > 0) luckyBox._snapshotServerNow = packetAt;
            if (serverNow) secureSetServerNow(serverNow);
            if (luckyBox.claimed && !raw.claimed && raw.active && cycle === luckyBox.spawnCycle) {
                // The server released the previous claim. Contact now is a new
                // logical attempt, rather than a replay of its expired receipt.
                luckyBox._actionCycle = null;
            }
            luckyBox.nextSpawnTimestamp = nextSpawnTimestamp;
            luckyBox.spawnCycle = cycle;
            luckyBox.claimExpiresAt = Number(raw.claimExpiresAt ?? 0) || 0;
            luckyBox.claimed = Boolean(raw.claimed);
            luckyBox.serverActive = Boolean(raw.active);
            luckyBox.collecting = false;

            const x = Number(raw.x);
            const z = Number(raw.z);
            if (Number.isFinite(x) && Number.isFinite(z)) {
                luckyBox.mesh.position.set(x, 0, z);
            }

            const now = secureNow();
            const claimStillActive = luckyBox.claimed && luckyBox.claimExpiresAt > now;
            const waitingRespawn = luckyBox.nextSpawnTimestamp > now;
            luckyBox.active = luckyBox.serverActive && !claimStillActive && !waitingRespawn;
            luckyBox.mesh.visible = luckyBox.active;
            secureUpdateLuckyBoxTimer();
        }

        function secureUpdateLuckyBoxTimer() {
            const timerEl = document.getElementById('hud-box-timer');
            if (!timerEl || !luckyBox) return;

            const now = secureNow();

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

            // Legacy snapshots may have a pending spin without a cooldown.
            // A collection-time cooldown takes priority for every observer.
            if (luckyBox.claimed && luckyBox.claimExpiresAt > now) {
                timerEl.innerText = 'มีผู้เล่นกำลังสุ่ม...';
                luckyBox.active = false;
                if (luckyBox.mesh) luckyBox.mesh.visible = false;
                return;
            }

            // A clock reaching zero cannot create an authoritative spawn or
            // release a claim. The room publishes its persisted active state.
            luckyBox.active = Boolean(luckyBox.serverActive) && !luckyBox.claimed;
            if (luckyBox.mesh) luckyBox.mesh.visible = luckyBox.active;
            timerEl.innerText = luckyBox.active ? 'พร้อมเปิด!' : 'กำลังรอสถานะจาก Server...';
        }

        function secureRetryPendingBoxClaim() {
            const requestId = luckyBox?._claimPendingRequestId;
            if (!requestId || luckyBox._actionUid !== auth.currentUser?.uid ||
                !state.isPlaying || state.isPaused || secureHandoffInProgress ||
                !luckyBox.claimed || luckyBox.claimExpiresAt <= secureNow() ||
                !secureGameReady || !secureGameSocket || secureGameSocket.readyState !== WebSocket.OPEN) return;
            // A snapshot does not identify the owner. Replay the original request
            // for server authorization; only BOX_SPIN_READY may open the wheel.
            try {
                secureGameSocket.send(JSON.stringify({ type: protocol.WS_MESSAGE.COLLECT_BOX, requestId }));
            } catch (_) { /* Keep the unresolved identity for a later resume. */ }
        }

        function secureRequestLuckyBoxCollect() {
            if (secureHandoffInProgress || !luckyBox || !luckyBox.active || luckyBox.collecting) return;
            if (!secureGameReady || !secureGameSocket || secureGameSocket.readyState !== WebSocket.OPEN) return;
            const uid = String(auth.currentUser?.uid || '');
            if (!luckyBox._claimActionRequestId || luckyBox._actionCycle !== luckyBox.spawnCycle || luckyBox._actionUid !== uid) {
                luckyBox._actionCycle = luckyBox.spawnCycle;
                luckyBox._actionUid = uid;
                luckyBox._claimActionRequestId = secureEconomyRequestId('box-claim');
                luckyBox._spinActionRequestId = null;
            }
            luckyBox.collecting = true;
            luckyBox._claimPendingRequestId = luckyBox._claimActionRequestId;
            setTimeout(() => { if (luckyBox) luckyBox.collecting = false; }, 1200);
            try {
                secureGameSocket.send(JSON.stringify({ type: protocol.WS_MESSAGE.COLLECT_BOX,
                    requestId: luckyBox._claimActionRequestId }));
            } catch (_) {
                luckyBox.collecting = false;
            }
        }

        spawnLuckyBoxes = function() {
            clearLuckyBoxMesh();
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
                claimed: false,
                serverActive: false
            };
            luckyBoxServerRef = null;
            const timerEl = document.getElementById('hud-box-timer');
            if (timerEl) timerEl.innerText = 'กำลังโหลดจาก Server...';
        };

        triggerLuckyBoxModal = function() {
            state.wheelAnimation = null;
            if (typeof window !== 'undefined' && typeof window.resetGameplayInput === 'function') window.resetGameplayInput();
            state.isPaused = true;
            const localNameTag = document.getElementById('player-nametag');
            if (localNameTag) localNameTag.style.display = 'none';
            state.wheelSpinning = false;
            state.wheelReward = null;
            document.getElementById('wheel-modal').classList.remove('hidden');
            document.getElementById('btn-spin-wheel').classList.remove('hidden');
            document.getElementById('btn-close-wheel').classList.add('hidden');
            document.getElementById('btn-close-wheel').innerText = 'รับรางวัล & เล่นต่อ';
            document.getElementById('wheel-result-msg').innerText = 'กดปุ่มเพื่อเริ่มหมุนวงล้อ!';
            drawLuckyWheel();
            audio.playBoxHit();
        };

        spinWheel = function() {
            if (state.wheelSpinning || secureHandoffInProgress || !luckyBox) return;
            if (!secureGameReady || !secureGameSocket || secureGameSocket.readyState !== WebSocket.OPEN) {
                alert('Game Server หลุด กรุณาเข้าเกมใหม่');
                return;
            }
            state.wheelSpinning = true;
            document.getElementById('btn-spin-wheel').classList.add('hidden');
            document.getElementById('wheel-result-msg').innerText = 'กำลังขอผลสุ่มจาก Server...';
            if (!luckyBox._spinActionRequestId) luckyBox._spinActionRequestId = secureEconomyRequestId('box-spin');
            const requestId = luckyBox._spinActionRequestId;
            luckyBox._spinPendingRequestId = requestId;
            const attempt = {};
            luckyBox._spinPendingAttempt = attempt;
            const allowRetry = () => {
                if (luckyBox?._spinPendingRequestId !== requestId ||
                    luckyBox._spinPendingAttempt !== attempt) return;
                luckyBox._spinPendingRequestId = null;
                state.wheelSpinning = false;
                document.getElementById('btn-spin-wheel').classList.remove('hidden');
                document.getElementById('wheel-result-msg').innerText = 'ยังไม่ได้รับผลจาก Server กรุณาลองอีกครั้ง';
            };
            try {
                secureGameSocket.send(JSON.stringify({ type: protocol.WS_MESSAGE.SPIN_BOX, requestId }));
                setTimeout(allowRetry, 2700);
            } catch (_) {
                allowRetry();
            }
        };
