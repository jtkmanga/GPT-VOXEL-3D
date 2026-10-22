        let secureInputSequence = 0;
        let secureLastAcknowledgedSequence = -1;
        let secureJumpIntent = false;
        let secureJumpGeneration = 0;
        let secureJumpHeld = false;
        const securePendingFrames = [];
        const securePendingInputs = [];
        const securePredictionCorrection = { x: 0, y: 0, z: 0 };

        function secureQueueJump() {
            secureJumpGeneration++;
            secureJumpIntent = true;
        }

        function secureMovementIntent() {
            const directionalKeys = typeof keys === 'object' ? keys : {};
            const joystick = typeof joystickVec === 'object' ? joystickVec : { x: 0, y: 0 };
            const yaw = typeof cameraYaw === 'number' ? cameraYaw : 0;
            let x = (directionalKeys.d ? 1 : 0) - (directionalKeys.a ? 1 : 0);
            let z = (directionalKeys.s ? 1 : 0) - (directionalKeys.w ? 1 : 0);
            if (Math.abs(joystick.x) > .05) x = joystick.x;
            if (Math.abs(joystick.y) > .05) z = joystick.y;
            const length = Math.hypot(x, z);
            if (length <= .05) return { x: 0, z: 0, jump: secureJumpIntent };
            const divisor = Math.max(1, length);
            const magnitude = Math.min(length, 1);
            const right = x / divisor;
            const forward = -z / divisor;
            // Preserve the original camera-relative controls and analog response.
            return {
                x: (right * Math.cos(yaw) - forward * Math.sin(yaw)) * magnitude,
                z: (-right * Math.sin(yaw) - forward * Math.cos(yaw)) * magnitude,
                jump: secureJumpIntent
            };
        }

        function secureMovementState() {
            return { x: playerPos.x, y: playerPos.y, z: playerPos.z, r: playerRotation,
                vx: playerVel.x, vz: playerVel.z, vy: playerVelocityY, grounded: isGrounded,
                jumpHeld: secureJumpHeld };
        }

        function secureApplyMovementState(position) {
            playerPos.set(position.x, position.y, position.z);
            playerRotation = position.r;
            playerVel.x = position.vx;
            playerVel.z = position.vz;
            playerVelocityY = position.vy;
            isGrounded = position.grounded;
            secureJumpHeld = Boolean(position.jumpHeld);
        }

        function secureMovementOptions() {
            return {
                speed: state.shop.speedBuffExpires > secureNow()
                    ? movement.MOVEMENT.entitledSpeed : movement.MOVEMENT.speed,
                obstacles: [...(typeof buildings === 'undefined' ? [] : buildings),
                    ...(typeof trees === 'undefined' ? [] : trees)],
                bounds: movement.MOVEMENT.bounds
            };
        }

        function securePredictMovement(delta) {
            // Lost connections and provisional handoffs cannot advance a player.
            // Camera and rendering continue while authority is being recovered.
            if (!secureGameReady || (secureHandoffInProgress &&
                !(typeof secureContinuousHandoffPredictionAllowed === 'function' && secureContinuousHandoffPredictionAllowed())) || !secureGameSocket ||
                secureGameSocket.readyState !== WebSocket.OPEN) return;
            const input = secureMovementIntent();
            input.jump = secureJumpIntent;
            const elapsed = Math.min(.1, Math.max(0, Number.isFinite(delta) ? delta : 0));
            const options = secureMovementOptions();
            secureApplyMovementState(movement.integrateMovement(secureMovementState(), input, elapsed, options));
            securePendingFrames.push({ seq: secureInputSequence, input, delta: elapsed, speed: options.speed });
            // A long stalled connection cannot retain unbounded prediction work.
            if (securePendingFrames.length > 256) securePendingFrames.splice(0, securePendingFrames.length - 256);
        }

        function secureResetPrediction(position, motion = {}) {
            if (!position || !['x', 'y', 'z'].every(key => Number.isFinite(Number(position[key])))) return false;
            const y = Math.max(0, Number(position.y));
            secureApplyMovementState({
                x: Number(position.x), y, z: Number(position.z),
                r: Number.isFinite(Number(position.r)) ? Number(position.r) : 0,
                vx: Number.isFinite(Number(motion.vx)) ? Number(motion.vx) : 0,
                vz: Number.isFinite(Number(motion.vz)) ? Number(motion.vz) : 0,
                vy: Number.isFinite(Number(motion.vy)) ? Number(motion.vy) : 0,
                grounded: typeof motion.grounded === 'boolean' ? motion.grounded : y === 0,
                jumpHeld: Boolean(motion.jumpHeld)
            });
            const lastSequence = Number.isSafeInteger(motion.lastSeq) && motion.lastSeq >= -1 ? motion.lastSeq : -1;
            secureInputSequence = lastSequence + 1;
            secureLastAcknowledgedSequence = lastSequence;
            securePendingFrames.length = 0;
            securePendingInputs.length = 0;
            secureJumpIntent = false;
            secureJumpGeneration++;
            securePredictionCorrection.x = securePredictionCorrection.y = securePredictionCorrection.z = 0;
            secureLastMoveSentAt = 0;
            if (playerGroup) {
                playerGroup.position.copy(playerPos);
                playerGroup.rotation.y = playerRotation;
            }
            return true;
        }

        function secureReconcileMovement(message) {
            const position = message?.player;
            const ack = Number(message?.ack);
            if (message?.applied === false || !position || !Number.isSafeInteger(ack) || ack < 0 ||
                ack <= secureLastAcknowledgedSequence || ack >= secureInputSequence ||
                !['x', 'y', 'z', 'r'].every(key => Number.isFinite(position[key]))) return false;
            const before = { x: playerPos.x, y: playerPos.y, z: playerPos.z };
            const motion = message.movement || {
                vx: message.velocity?.x, vz: message.velocity?.z,
                vy: message.velocity?.y, grounded: message.grounded
            };
            let corrected = { x: position.x, y: Math.max(0, position.y), z: position.z, r: position.r,
                vx: Number(motion.vx) || 0, vz: Number(motion.vz) || 0, vy: Number(motion.vy) || 0,
                grounded: typeof motion.grounded === 'boolean' ? motion.grounded : position.y <= 0,
                jumpHeld: Boolean(motion.jumpHeld) };
            secureLastAcknowledgedSequence = ack;
            if (securePendingInputs.some(packet => packet.seq <= ack && packet.input.jump &&
                packet.jumpGeneration === secureJumpGeneration)) secureJumpIntent = false;
            while (securePendingFrames.length && securePendingFrames[0].seq <= ack) securePendingFrames.shift();
            while (securePendingInputs.length && securePendingInputs[0].seq <= ack) securePendingInputs.shift();
            const options = secureMovementOptions();
            for (const frame of securePendingFrames) {
                corrected = movement.integrateMovement(corrected, frame.input, frame.delta,
                    { ...options, speed: frame.speed });
            }
            secureApplyMovementState(corrected);
            const difference = Math.hypot(before.x - corrected.x, before.y - corrected.y, before.z - corrected.z);
            if (difference <= 4) {
                securePredictionCorrection.x += before.x - corrected.x;
                securePredictionCorrection.y += before.y - corrected.y;
                securePredictionCorrection.z += before.z - corrected.z;
            } else {
                securePredictionCorrection.x = securePredictionCorrection.y = securePredictionCorrection.z = 0;
            }
            if (secureZoneFromPosition(position.x, position.z) === secureCurrentZoneId) {
                secureLastStablePosition = { x: position.x, y: position.y, z: position.z, r: position.r };
            }
            return true;
        }

        // Resume capabilities stay in memory and are scoped to a verified SDK UID
        // and Zone. A capability never replaces Firebase ID-token verification.
        const secureSessionTickets = new Map();
        const secureSocketRefreshTimers = new WeakMap();
        const secureSocketRefreshExpiries = new WeakMap();
        const secureClientSockets = new Set();
        const secureClientWaiters = new Set();
        let secureClientConnectionEpoch = 0;
        let secureActiveHandoff = null;
        let secureReconnectInProgress = false;
        let secureReconnectGeneration = 0;

        function secureConnectionEpoch() {
            return secureClientConnectionEpoch;
        }

        function secureConnectionIsCurrent(epoch) {
            return epoch === secureClientConnectionEpoch;
        }

        function secureRegisterClientSocket(ws) {
            secureClientSockets.add(ws);
        }

        function secureUnregisterClientSocket(ws) {
            secureClientSockets.delete(ws);
        }

        function secureStartHandoffOperation(source) {
            const operation = {
                source, target: null, uid: auth.currentUser?.uid,
                epoch: secureClientConnectionEpoch, cancelled: false
            };
            if (source) secureClientSockets.add(source);
            secureActiveHandoff = operation;
            return operation;
        }

        function secureHandoffOperationIsCurrent(operation) {
            return !operation.cancelled && operation.epoch === secureClientConnectionEpoch &&
                operation.uid === auth.currentUser?.uid;
        }

        function secureRequireHandoffOperation(operation) {
            if (!secureHandoffOperationIsCurrent(operation)) {
                const error = new Error('Session เปลี่ยนหรือยกเลิกระหว่างย้าย Zone');
                error.securityCancelled = true;
                throw error;
            }
        }

        function secureFinishHandoffOperation(operation) {
            if (secureActiveHandoff === operation) secureActiveHandoff = null;
        }

        function secureClientDelay(delay) {
            return new Promise((resolve, reject) => {
                const waiter = { timer: null, reject };
                waiter.timer = setTimeout(() => {
                    secureClientWaiters.delete(waiter);
                    resolve();
                }, delay);
                secureClientWaiters.add(waiter);
            });
        }

        function secureAbortClientConnections(reason = 'Session cancelled', closeCode = 1000) {
            secureClientConnectionEpoch++;
            secureCancelReconnect();
            if (secureActiveHandoff) {
                secureActiveHandoff.cancelled = true;
                if (typeof secureAbortContinuousHandoff === 'function') secureAbortContinuousHandoff(secureActiveHandoff, reason);
                if (secureActiveHandoff.source) secureClientSockets.add(secureActiveHandoff.source);
                if (secureActiveHandoff.target) secureClientSockets.add(secureActiveHandoff.target);
            }
            const rejectResume = secureHandoffResumeReject;
            if (secureHandoffResumeTimer) clearTimeout(secureHandoffResumeTimer);
            secureHandoffResumeTimer = null;
            secureHandoffResumeResolve = null;
            secureHandoffResumeReject = null;
            if (rejectResume) {
                const error = new Error(reason);
                error.securityCancelled = true;
                rejectResume(error);
            }
            for (const waiter of secureClientWaiters) {
                clearTimeout(waiter.timer);
                const error = new Error(reason);
                error.securityCancelled = true;
                waiter.reject(error);
            }
            secureClientWaiters.clear();
            if (secureGameSocket) secureClientSockets.add(secureGameSocket);
            for (const ws of [...secureClientSockets]) {
                secureClearSocketRefresh(ws);
                secureCloseSocket(ws, closeCode, reason);
            }
            secureClientSockets.clear();
            secureGameSocket = null;
            secureGameReady = false;
            secureHandoffInProgress = false;
            secureActiveHandoff = null;
        }

        function secureSessionKey(zoneId, uid = auth.currentUser?.uid, serverId = state.selectedServerId || 'free1') {
            if (serverId === 'vip1') return typeof uid === 'string' && uid ? `${uid}:vip1` : '';
            if (serverId !== 'free1') return '';
            const zone = secureNormalizeZoneId(zoneId);
            return typeof uid === 'string' && uid && zone ? `${uid}:${zone}` : '';
        }

        function secureGetResumeTicket(zoneId, uid = auth.currentUser?.uid, serverId = state.selectedServerId || 'free1') {
            const key = secureSessionKey(zoneId, uid, serverId);
            const ticket = key && secureSessionTickets.get(key);
            if (!ticket || ticket.resumeExpiresAt <= secureNow()) {
                if (key) secureSessionTickets.delete(key);
                return null;
            }
            return ticket;
        }

        function secureRememberSession(zoneId, session, serverId = state.selectedServerId || 'free1') {
            const key = secureSessionKey(zoneId, auth.currentUser?.uid, serverId);
            if (!key || !session || typeof session.resumeToken !== 'string' ||
                !session.resumeToken || typeof session.sessionId !== 'string' ||
                !Number.isFinite(session.resumeExpiresAt) || session.resumeExpiresAt <= secureNow()) return;
            secureSessionTickets.set(key, {
                resumeToken: session.resumeToken,
                resumeExpiresAt: session.resumeExpiresAt,
                sessionId: session.sessionId
            });
        }

        function secureClearSocketRefresh(ws) {
            const timer = secureSocketRefreshTimers.get(ws);
            if (timer) clearTimeout(timer);
            secureSocketRefreshTimers.delete(ws);
            secureSocketRefreshExpiries.delete(ws);
        }

        function secureForgetResumeTicket(zoneId) {
            const key = secureSessionKey(zoneId);
            if (key) secureSessionTickets.delete(key);
        }

        function secureTrackAuthenticatedSocket(ws, zoneId, session) {
            const serverId = ws.secureServerId || state.selectedServerId || 'free1';
            secureRememberSession(zoneId, session, serverId);
            // Lease notices renew the resume capability, not the Firebase token.
            // An unchanged expiry must not postpone or repeat an existing refresh.
            if (session && secureSocketRefreshExpiries.get(ws) === session.tokenExpiresAt) return;
            secureClearSocketRefresh(ws);
            const uid = auth.currentUser?.uid;
            if (!session || !uid || !Number.isFinite(session.tokenExpiresAt)) return;
            secureSocketRefreshExpiries.set(ws, session.tokenExpiresAt);
            const delay = Math.max(1000, Math.min(45 * 60_000, session.tokenExpiresAt - secureNow() - 60_000));
            const timer = setTimeout(async () => {
                secureSocketRefreshTimers.delete(ws);
                if (ws !== secureGameSocket || ws.readyState !== WebSocket.OPEN ||
                    secureIntentionalSockets.has(ws)) return;
                if (auth.currentUser?.uid !== uid) {
                    secureCloseSocket(ws, 1008, 'Account changed');
                    secureReturnToMenu();
                    return;
                }
                try {
                    const token = await auth.currentUser.getIdToken(true);
                    if (ws !== secureGameSocket || ws.readyState !== WebSocket.OPEN) return;
                    if (auth.currentUser?.uid !== uid) {
                        secureCloseSocket(ws, 1008, 'Account changed');
                        secureReturnToMenu();
                        return;
                    }
                    ws.send(JSON.stringify({
                        type: protocol.WS_MESSAGE.AUTH,
                        token,
                        protocol: serverId === 'vip1' ? protocol.PROTOCOL_VERSION.LEGACY_ROOM : protocol.PROTOCOL_VERSION.ZONE_ROOM
                    }));
                    // The server's auth_refreshed response supplies the next expiry.
                } catch (_) {
                    if (ws !== secureGameSocket) return;
                    secureCloseSocket(ws, 1008, 'Token refresh failed');
                    secureReturnToMenu();
                }
            }, delay);
            secureSocketRefreshTimers.set(ws, timer);
        }

        function secureCancelReconnect() {
            secureReconnectGeneration++;
        }

        async function secureResumeDisconnectedSocket(zoneId, uid, serverId = state.selectedServerId || 'free1') {
            if (secureReconnectInProgress || !secureGetResumeTicket(zoneId, uid, serverId)) return false;
            secureReconnectInProgress = true;
            const generation = ++secureReconnectGeneration;
            try {
                for (let attempt = 0; attempt < 3; attempt++) {
                    await secureClientDelay(250 * (2 ** attempt));
                    if (generation !== secureReconnectGeneration || !state.isPlaying ||
                        secureHandoffInProgress || secureGameSocket || auth.currentUser?.uid !== uid ||
                        (state.selectedServerId || 'free1') !== serverId ||
                        !secureGetResumeTicket(zoneId, uid, serverId)) return false;
                    try {
                        await secureOpenZoneSocket(zoneId, '', attempt > 0, true);
                        return true;
                    } catch (_) {
                        // Only the original account and an unexpired server ticket
                        // can retry. A retry cannot fall back to a new spawn/session.
                    }
                }
                return false;
            } finally {
                secureReconnectInProgress = false;
            }
        }

        function secureHandleSocketMessage(message) {
            if (!message || typeof message !== 'object') return;

            switch (message.type) {
                case protocol.WS_MESSAGE.WELCOME: {
                    if (message.serverNow) secureSetServerNow(message.serverNow);
                    const isSmoothHandoffWelcome = Boolean(message.handoff) && secureHandoffInProgress;
                    const isContinuousHandoffWelcome = isSmoothHandoffWelcome &&
                        typeof secureContinuousHandoffDefersWelcomeWorld === 'function' && secureContinuousHandoffDefersWelcomeWorld();
                    secureCurrentZoneId = secureNormalizeZoneId(message.zone) || secureCurrentZoneId;
                    state.serverPlayerId = String(message.id || '');
                    if (!isContinuousHandoffWelcome) {
                        state.score = Number(message.score) || 0;
                        updateScoreDisplay();
                    }

                    // Login/resume starts from persisted authority. A provisional
                    // target welcome keeps rendering stable until ownership ACK.
                    if (message.spawn && !isSmoothHandoffWelcome) {
                        secureResetPrediction(message.spawn, message.movement || message.motion);
                        secureRememberStablePosition();
                    }

                    if (isSmoothHandoffWelcome) {
                        secureDropRemoteSource('local');
                    } else {
                        secureClearRemoteState();
                    }

                    (Array.isArray(message.players) ? message.players : []).forEach(raw => {
                        const p = secureNormalizePlayer(raw);
                        if (p.id && p.id !== state.serverPlayerId) {
                            secureTrackRemotePlayer(p.id, 'local', p);
                        }
                    });

                    if (isContinuousHandoffWelcome) {
                        // Keep the owning source's live world state. The target's
                        // fresh commit snapshot arrives with its ownership ACK.
                    } else if (isSmoothHandoffWelcome) {
                        // Refresh global world UI outside the critical handoff path so
                        // 200 coin mesh updates cannot create a visible boundary hitch.
                        requestAnimationFrame(() => {
                            secureApplyCoinSnapshot(message.coins, message.serverNow);
                            secureApplyLuckyBoxState(message.luckyBox, message.serverNow);
                            updateLeaderboardUI(secureNormalizeLeaderboard(message.leaderboard));
                        });
                    } else {
                        secureApplyCoinSnapshot(message.coins, message.serverNow);
                        secureApplyLuckyBoxState(message.luckyBox, message.serverNow);
                        updateLeaderboardUI(secureNormalizeLeaderboard(message.leaderboard));
                    }

                    secureGameReady = true;
                    if (!isSmoothHandoffWelcome && typeof secureRetryPendingBoxClaim === 'function') secureRetryPendingBoxClaim();
                    break;
                }
                case protocol.WS_MESSAGE.JOIN: {
                    const p = secureNormalizePlayer(message.player);
                    if (p.id && p.id !== state.serverPlayerId) secureTrackRemotePlayer(p.id, 'local', p);
                    break;
                }
                case protocol.WS_MESSAGE.MOVE: {
                    const p = secureNormalizePlayer(message.player);
                    if (!p.id) break;
                    if (p.id === state.serverPlayerId) {
                        if (message.serverNow) secureSetServerNow(message.serverNow);
                        secureReconcileMovement(message);
                        break;
                    }
                    secureTrackRemotePlayer(p.id, 'local', p);
                    break;
                }
                case protocol.WS_MESSAGE.LEAVE:
                    if (message.id) secureUntrackRemotePlayer(String(message.id), 'local');
                    break;
                case protocol.WS_MESSAGE.GHOST_SNAPSHOT:
                    if (state.selectedServerId === 'vip1' || secureGameSocket?.secureServerId === 'vip1') break;
                    secureReplaceGhostSnapshot(message);
                    break;
                case protocol.WS_MESSAGE.ZONE_CHANGE:
                    if (state.selectedServerId === 'vip1' || secureGameSocket?.secureServerId === 'vip1') break;
                    void secureBeginZoneHandoff(message);
                    break;
                case protocol.WS_MESSAGE.SCORE:
                    state.score = Math.max(Number(state.score) || 0, Number(message.score) || 0);
                    updateScoreDisplay();
                    break;
                case protocol.WS_MESSAGE.LEADERBOARD:
                    updateLeaderboardUI(secureNormalizeLeaderboard(message.top));
                    break;
                case protocol.WS_MESSAGE.COIN_COLLECT_RESULT: {
                    const id = Number(message?.id);
                    if (Number.isInteger(id) && id >= 0 && id < coins.length) {
                        const coin = coins[id];
                        if (message.requestId && coin._collectActionRequestId &&
                            message.requestId !== coin._collectActionRequestId &&
                            Number(coin._collectPendingUntil || 0) > 0) break;
                        if (Number.isSafeInteger(message.cycle) && Number.isSafeInteger(coin.serverCycle) &&
                            message.cycle < coin.serverCycle) break;
                        secureApplyCoinRetryDelay(coin, message);
                        coin._collectPendingUntil = 0;
                        if (message.collected) {
                            if (Number.isFinite(Number(message.score))) {
                                state.score = Math.max(Number(state.score) || 0, Number(message.score));
                                updateScoreDisplay();
                            }
                            if (message.event) secureUpdateCoinState(message.event);
                        } else {
                            if (message.requestId === coin._collectActionRequestId) coin._collectActionRequestId = null;
                            if (message.event) {
                                secureUpdateCoinState(message.event);
                            } else {
                                if (message.serverNow) secureSetServerNow(message.serverNow);
                                const activeAfter = Object.hasOwn(message, 'activeAfter')
                                    ? Number(message.activeAfter) || 0 : Number(coin.respawnTime) || 0;
                                coin.respawnTime = activeAfter;
                                coin.active = activeAfter <= secureNow();
                                coin.mesh.visible = coin.active;
                            }
                        }
                    }
                    break;
                }
                case protocol.WS_MESSAGE.COIN_COLLECTED:
                case protocol.WS_MESSAGE.COIN_STATE:
                    if (message.type === protocol.WS_MESSAGE.COIN_STATE && Array.isArray(message.coins)) {
                        secureApplyCoinSnapshot(message.coins, message.serverNow);
                    } else {
                        secureUpdateCoinState(message);
                    }
                    break;
                case protocol.WS_MESSAGE.BOX_STATE:
                    if (message.requestId && message.claimed === false &&
                        message.requestId === luckyBox?._claimActionRequestId) {
                        luckyBox._claimActionRequestId = null;
                        luckyBox._claimPendingRequestId = null;
                        luckyBox._actionCycle = null;
                    }
                    secureApplyLuckyBoxState(message.box || message.luckyBox || message, message.serverNow);
                    break;
                case protocol.WS_MESSAGE.BOX_SPIN_READY:
                    if (message.requestId && luckyBox?._claimActionRequestId &&
                        message.requestId !== luckyBox._claimActionRequestId) break;
                    if (luckyBox) luckyBox._claimPendingRequestId = null;
                    secureApplyLuckyBoxState(message.box || message.luckyBox || null, message.serverNow);
                    triggerLuckyBoxModal();
                    break;
                case protocol.WS_MESSAGE.BOX_REWARD: {
                    if (message.serverNow) secureSetServerNow(message.serverNow);
                    if (Number.isFinite(Number(message.score))) {
                        state.score = Math.max(Number(state.score) || 0, Number(message.score));
                        updateScoreDisplay();
                    }
                    if (message.requestId && luckyBox?._spinActionRequestId &&
                        message.requestId !== luckyBox._spinActionRequestId) break;
                    if (luckyBox) {
                        if ((message.receipt && message.receipt === luckyBox._lastRewardReceipt) ||
                            (message.requestId && message.requestId === luckyBox._lastRewardRequestId)) break;
                        luckyBox._lastRewardReceipt = message.receipt || null;
                        luckyBox._lastRewardRequestId = message.requestId || null;
                        luckyBox._spinPendingRequestId = null;
                    }
                    secureAnimateWheelToReward(Number(message.reward) || 0);
                    break;
                }
                case protocol.WS_MESSAGE.BOX_ERROR:
                    console.warn('Lucky Box:', message.message || message);
                    if (luckyBox?._claimPendingRequestId && message.requestId === luckyBox._claimPendingRequestId) {
                        luckyBox._claimPendingRequestId = null;
                    }
                    if (luckyBox?._spinPendingRequestId &&
                        (!message.requestId || message.requestId === luckyBox._spinPendingRequestId)) {
                        luckyBox._spinPendingRequestId = null;
                        state.wheelSpinning = false;
                        document.getElementById('btn-spin-wheel').classList.remove('hidden');
                        document.getElementById('wheel-result-msg').innerText = 'Server ยังไม่ยืนยันผล กรุณาลองอีกครั้ง';
                    }
                    // Timeout clears an attempt, not the unresolved action.
                    // Never replace an accepted reward or a newer action's UI.
                    if (state.isPlaying && state.isPaused && message.requestId &&
                        message.requestId === luckyBox?._spinActionRequestId &&
                        message.requestId !== luckyBox._lastRewardRequestId &&
                        message.message === 'Lucky Box claim expired') {
                            luckyBox._spinPendingRequestId = null;
                            state.wheelSpinning = false;
                            document.getElementById('btn-spin-wheel').classList.add('hidden');
                            document.getElementById('btn-close-wheel').innerText = 'เล่นต่อ';
                            document.getElementById('btn-close-wheel').classList.remove('hidden');
                            document.getElementById('wheel-result-msg').innerText = 'สิทธิ์หมุนหมดอายุแล้ว กลับไปเล่นต่อได้';
                    }
                    break;
                case protocol.WS_MESSAGE.HANDOFF_RESUMED:
                    // An ACK owns only the currently pending transfer. A late ACK
                    // cannot revive a timed-out/cancelled provisional socket.
                    if (!secureHandoffInProgress || !secureHandoffResumeResolve) break;
                    if (message.serverNow) secureSetServerNow(message.serverNow);
                    if (typeof secureContinuousHandoffRequiresAck === 'function' && secureContinuousHandoffRequiresAck()) {
                        if (message.continuousHandoff !== true || !secureApplyContinuousHandoffAck(message)) {
                            secureAbortClientConnections('Invalid continuous handoff authority', 1008);
                            secureReturnToMenu();
                            break;
                        }
                    } else if (typeof secureResetPrediction === 'function') {
                        secureResetPrediction(message.position || message, message.movement || message.motion);
                    }
                    if (typeof secureTrackAuthenticatedSocket === 'function' && secureGameSocket) {
                        secureTrackAuthenticatedSocket(secureGameSocket, message.zone || secureCurrentZoneId, message.session);
                    }
                    if (secureHandoffResumeTimer) clearTimeout(secureHandoffResumeTimer);
                    secureHandoffResumeTimer = null;
                    if (secureHandoffResumeResolve) secureHandoffResumeResolve(message);
                    secureHandoffResumeResolve = null;
                    secureHandoffResumeReject = null;
                    break;
                case protocol.WS_MESSAGE.HANDOFF_RESUME_ERROR: {
                    if (secureHandoffResumeTimer) clearTimeout(secureHandoffResumeTimer);
                    secureHandoffResumeTimer = null;
                    const err = new Error(message.message || 'Target Zone ปฏิเสธตำแหน่งต่อเนื่อง');
                    err.retryable = Boolean(message.retryable);
                    if (message.continuousHandoff) {
                        err.continuousHandoff = true;
                        err.cancelledToSource = Boolean(message.cancelledToSource);
                        err.retargetZone = secureNormalizeZoneId(message.retargetZone);
                    }
                    if (secureHandoffResumeReject) secureHandoffResumeReject(err);
                    secureHandoffResumeResolve = null;
                    secureHandoffResumeReject = null;
                    break;
                }
                case protocol.WS_MESSAGE.HANDOFF_CANCELLED:
                    if (typeof secureContinuousHandoffRequiresAck === 'function' && secureContinuousHandoffRequiresAck()) {
                        if (message.continuousHandoff === true) secureApplyContinuousHandoffCancel(message);
                        break;
                    }
                    if (message.serverNow) secureSetServerNow(message.serverNow);
                    if (message.position && typeof secureResetPrediction === 'function') {
                        const nextSequence = secureInputSequence;
                        secureResetPrediction(message.position, message.movement || message.motion);
                        secureInputSequence = Math.max(nextSequence, secureInputSequence,
                            Number.isSafeInteger(message.nextSequence) && message.nextSequence >= 0
                                ? message.nextSequence : 0);
                        secureRememberStablePosition();
                    }
                    break;
                case protocol.WS_MESSAGE.HANDOFF_ERROR:
                    console.warn('Zone handoff:', message.message || message);
                    break;
                case protocol.WS_MESSAGE.AUTH_ERROR:
                    console.warn('Game auth:', message.message || message);
                    break;
                case protocol.WS_MESSAGE.AUTH_REFRESHED:
                    if (message.serverNow) secureSetServerNow(message.serverNow);
                    if (typeof secureTrackAuthenticatedSocket === 'function' && secureGameSocket) {
                        secureTrackAuthenticatedSocket(secureGameSocket, secureCurrentZoneId, message.session);
                    }
                    if (message.entitlements && typeof secureApplyEntitlements === 'function') {
                        secureApplyEntitlements(message.entitlements, null, message.serverNow);
                    }
                    break;
                case protocol.WS_MESSAGE.SERVER_ERROR:
                    console.error('Game server error:', message.message || message);
                    break;
            }
        }

        async function secureOpenZoneSocket(zoneId, handoffToken = '', forceTokenRefresh = false, requireResume = false, savedZoneRedirected = false) {
            if (!auth.currentUser) throw new Error('ต้องล็อกอิน Google ก่อนเข้าเล่น');
            const serverId = state.selectedServerId || 'free1';
            if (!['free1', 'vip1'].includes(serverId) || (serverId === 'vip1' && handoffToken)) {
                throw new Error('Server หรือ handoff ไม่ถูกต้อง');
            }
            const normalizedZone = secureNormalizeZoneId(zoneId);
            if (!normalizedZone) throw new Error('Zone ไม่ถูกต้อง');
            if (requireResume && (typeof secureGetResumeTicket !== 'function' || !secureGetResumeTicket(normalizedZone))) {
                throw new Error('Session เดิมหมดอายุ กรุณาเข้าเกมใหม่');
            }

            const user = auth.currentUser;
            const uid = user.uid;
            const connectionEpoch = typeof secureConnectionEpoch === 'function' ? secureConnectionEpoch() : null;
            const connectionCurrent = () => auth.currentUser === user && auth.currentUser?.uid === uid &&
                (state.selectedServerId || 'free1') === serverId &&
                (connectionEpoch === null || typeof secureConnectionIsCurrent !== 'function' || secureConnectionIsCurrent(connectionEpoch));
            const token = await user.getIdToken(forceTokenRefresh);
            if (!connectionCurrent()) {
                throw new Error('บัญชีเปลี่ยนระหว่างเชื่อมต่อ Game Server');
            }

            return new Promise((resolve, reject) => {
                const ws = new WebSocket(secureZoneSocketUrl(normalizedZone, serverId));
                ws.secureAuthenticatedUid = uid;
                ws.secureServerId = serverId;
                if (typeof secureContinuousHandoffSocketOpened === 'function') secureContinuousHandoffSocketOpened(ws, handoffToken);
                if (typeof secureRegisterClientSocket === 'function') secureRegisterClientSocket(ws);
                let welcomed = false;
                let settled = false;
                let resumeRequested = false;

                const timer = setTimeout(() => {
                    if (settled) return;
                    settled = true;
                    secureCloseSocket(ws, 1000, 'Welcome timeout');
                    reject(new Error('เชื่อมต่อ Zone Server ไม่สำเร็จภายในเวลาที่กำหนด'));
                }, 10_000);

                const failBeforeWelcome = (message) => {
                    if (settled || welcomed) return;
                    settled = true;
                    clearTimeout(timer);
                    secureCloseSocket(ws, 1000, 'Auth failed');
                    reject(new Error(message));
                };

                ws.onopen = () => {
                    if (settled || ws.readyState !== WebSocket.OPEN) return;
                    if (!connectionCurrent()) {
                        failBeforeWelcome('บัญชีเปลี่ยนระหว่างเชื่อมต่อ Game Server');
                        return;
                    }
                    const authMessage = {
                        type: protocol.WS_MESSAGE.AUTH,
                        token,
                        protocol: serverId === 'vip1' ? protocol.PROTOCOL_VERSION.LEGACY_ROOM : protocol.PROTOCOL_VERSION.ZONE_ROOM,
                        name: String(state.playerName || 'Player').trim().slice(0, 12)
                    };
                    if (typeof secureUseContinuousHandoff === 'function' && secureUseContinuousHandoff(serverId)) {
                        authMessage.continuousHandoff = true;
                    }
                    if (handoffToken) authMessage.handoffToken = String(handoffToken);
                    else if (typeof secureGetResumeTicket === 'function') {
                        const ticket = secureGetResumeTicket(normalizedZone, uid, serverId);
                        if (requireResume && !ticket) {
                            failBeforeWelcome('Session เดิมหมดอายุ กรุณาเข้าเกมใหม่');
                            return;
                        }
                        if (ticket) {
                            authMessage.resumeToken = ticket.resumeToken;
                            resumeRequested = true;
                        }
                    }
                    ws.send(JSON.stringify(authMessage));
                };

                ws.onmessage = event => {
                    let message;
                    try {
                        message = JSON.parse(event.data);
                    } catch (err) {
                        console.warn('Invalid game socket message:', err);
                        return;
                    }

                    if (!welcomed) {
                        if (settled || ws.readyState !== WebSocket.OPEN) return;
                        if (message?.type === protocol.WS_MESSAGE.WELCOME) {
                            if (serverId === 'vip1' && (message.server !== 'vip1' || message.protocol !== protocol.PROTOCOL_VERSION.LEGACY_ROOM || message.handoff)) {
                                failBeforeWelcome('VIP Server ไม่ยืนยันห้องหรือ protocol');
                                return;
                            }
                            if (!connectionCurrent()) {
                                failBeforeWelcome('บัญชีเปลี่ยนระหว่างเชื่อมต่อ Game Server');
                                return;
                            }
                            welcomed = true;
                            settled = true;
                            clearTimeout(timer);
                            secureGameSocket = ws;
                            secureGameReady = true;
                            secureCurrentZoneId = secureNormalizeZoneId(message.zone) || normalizedZone;
                            secureHandleSocketMessage(message);
                            if (typeof secureTrackAuthenticatedSocket === 'function') {
                                secureTrackAuthenticatedSocket(ws, secureCurrentZoneId, message.session);
                            }
                            resolve({ ws, welcome: message });
                            return;
                        }
                        if (message?.type === protocol.WS_MESSAGE.AUTH_ERROR || message?.type === protocol.WS_MESSAGE.HANDOFF_ERROR || message?.type === protocol.WS_MESSAGE.SERVER_ERROR) {
                            // A freshly authenticated login can recover its saved
                            // Zone once. Resume/handoff capabilities remain bound
                            // to their original Zone and never follow redirects.
                            const savedZone = message.type === protocol.WS_MESSAGE.AUTH_ERROR &&
                                typeof message.resumeZone === 'string' && secureNormalizeZoneId(message.resumeZone);
                            if (serverId === 'free1' && !savedZoneRedirected && !handoffToken && !requireResume && !resumeRequested &&
                                savedZone && savedZone === message.resumeZone && savedZone !== normalizedZone && connectionCurrent()) {
                                settled = true;
                                clearTimeout(timer);
                                secureCloseSocket(ws, 1000, 'Saved Zone redirect');
                                if (!connectionCurrent()) {
                                    reject(new Error('บัญชีเปลี่ยนระหว่างเชื่อมต่อ Game Server'));
                                    return;
                                }
                                secureOpenZoneSocket(savedZone, '', forceTokenRefresh, false, true).then(result => {
                                    if (!connectionCurrent()) {
                                        secureCloseSocket(result.ws, 1008, 'Account changed');
                                        reject(new Error('บัญชีเปลี่ยนระหว่างเชื่อมต่อ Game Server'));
                                        return;
                                    }
                                    resolve(result);
                                }, reject);
                                return;
                            }
                            failBeforeWelcome(message.message || 'Game Server ปฏิเสธการเชื่อมต่อ');
                            return;
                        }
                        return;
                    }

                    const handoffDispatch = typeof secureDispatchContinuousHandoffSocket === 'function'
                        ? secureDispatchContinuousHandoffSocket(ws, message) : null;
                    if (handoffDispatch === true || (handoffDispatch !== false && ws === secureGameSocket)) {
                        secureHandleSocketMessage(message);
                    }
                };

                ws.onerror = () => {
                    if (!welcomed) failBeforeWelcome('WebSocket Zone Server มีปัญหา');
                };

                ws.onclose = event => {
                    clearTimeout(timer);
                    if (typeof secureUnregisterClientSocket === 'function') secureUnregisterClientSocket(ws);
                    if (typeof secureClearSocketRefresh === 'function') secureClearSocketRefresh(ws);
                    if (typeof stagingOnSocketClose === 'function') stagingOnSocketClose(ws, event);
                    if (typeof secureContinuousHandoffSocketClosed === 'function') secureContinuousHandoffSocketClosed(ws, event);
                    if (!welcomed && !settled) {
                        settled = true;
                        reject(new Error(`Zone Server ปิดการเชื่อมต่อ (${event.code})`));
                        return;
                    }

                    // Old sockets are intentionally left alive until a handoff target is ready.
                    // Once a new socket becomes active, closing the old one must not tear down the game.
                    if (ws !== secureGameSocket) return;

                    secureGameReady = false;
                    secureGameSocket = null;
                    const intentional = secureIntentionalSockets.has(ws);
                    if (!intentional && state.isPlaying && !secureHandoffInProgress) {
                        const failClosed = () => {
                            if (secureGameSocket || !state.isPlaying) return;
                            alert('การเชื่อมต่อ Game Server หลุด กรุณาเข้าเกมใหม่');
                            secureReturnToMenu();
                        };
                        // Policy rejection cannot be bypassed by reconnecting.
                        if (event.code === 1008 || event.code >= 4000 ||
                            typeof secureResumeDisconnectedSocket !== 'function') {
                            failClosed();
                        } else {
                            void secureResumeDisconnectedSocket(normalizedZone, uid, serverId).then(resumed => {
                                if (!resumed) failClosed();
                            }, failClosed);
                        }
                    }
                };
            });
        }

        function secureWaitForHandoffResumeAck(timeoutMs = 2500) {
            if (secureHandoffResumeTimer) clearTimeout(secureHandoffResumeTimer);
            secureHandoffResumeResolve = null;
            secureHandoffResumeReject = null;

            return new Promise((resolve, reject) => {
                secureHandoffResumeResolve = resolve;
                secureHandoffResumeReject = reject;
                secureHandoffResumeTimer = setTimeout(() => {
                    secureHandoffResumeTimer = null;
                    secureHandoffResumeResolve = null;
                    secureHandoffResumeReject = null;
                    reject(new Error('Target Zone ไม่ยืนยันตำแหน่งต่อเนื่องภายในเวลาที่กำหนด'));
                }, timeoutMs);
            });
        }

        async function secureResumeHandoffOnTarget(ws, targetZone, fromZone) {
            if (!ws || ws.readyState !== WebSocket.OPEN) {
                throw new Error('Target Zone socket ยังไม่พร้อม');
            }

            let lastError = null;
            for (let attempt = 0; attempt < 3; attempt++) {
                const continuous = typeof secureContinuousHandoffPredictionAllowed === 'function' && secureContinuousHandoffPredictionAllowed();
                const liveZone = secureZoneFromPosition(playerPos.x, playerPos.z);
                if (!continuous && liveZone === fromZone) {
                    const cancelled = new Error('ผู้เล่นกลับเข้า Zone เดิมระหว่าง handoff');
                    cancelled.cancelledToSource = true;
                    throw cancelled;
                }
                if (!continuous && liveZone && liveZone !== targetZone) {
                    const movedTooFar = new Error('ผู้เล่นเคลื่อนผ่าน Zone เป้าหมายระหว่าง handoff');
                    movedTooFar.retryable = false;
                    throw movedTooFar;
                }

                const ackPromise = secureWaitForHandoffResumeAck(3200);
                ws.send(JSON.stringify({
                    type: protocol.WS_MESSAGE.HANDOFF_RESUME,
                    input: continuous ? secureMovementIntent() : { x: 0, z: 0, jump: false }
                }));

                try {
                    return await ackPromise;
                } catch (err) {
                    lastError = err;
                    if (!err?.retryable || attempt >= 2) throw err;
                    if (typeof secureClientDelay === 'function') await secureClientDelay(120);
                    else await new Promise(resolve => setTimeout(resolve, 120));
                }
            }
            throw lastError || new Error('Handoff resume failed');
        }

        async function secureBeginZoneHandoff(message) {
            if (state.selectedServerId === 'vip1' || secureGameSocket?.secureServerId === 'vip1' || secureHandoffInProgress || !state.isPlaying) return;

            const fromZone = secureNormalizeZoneId(message?.from) || secureCurrentZoneId;
            const targetZone = secureNormalizeZoneId(message?.zone);
            const handoffToken = String(message?.handoffToken || '');
            const expiresAt = Number(message?.expiresAt || 0);
            if (!targetZone || !handoffToken || (expiresAt && expiresAt <= secureNow())) {
                console.warn('Ignored invalid/expired zone handoff', message);
                return;
            }

            const oldSocket = secureGameSocket;
            const fallback = { ...secureLastStablePosition };
            const operation = typeof secureStartHandoffOperation === 'function' ? secureStartHandoffOperation(oldSocket) : null;
            let targetSocket = null;
            secureHandoffInProgress = true;
            if (operation && typeof secureBeginContinuousHandoff === 'function') {
                secureBeginContinuousHandoff(operation, message, fromZone, targetZone);
            }

            // The staging source continues validated prediction and input while
            // the target authenticates. Legacy clients retain the paused path.
            // In either mode, resume cannot supply an authoritative position.
            try {
                const result = await secureOpenZoneSocket(targetZone, handoffToken, false);
                if (operation) secureRequireHandoffOperation(operation);
                targetSocket = result?.ws || secureGameSocket;
                if (operation) operation.target = targetSocket;

                if (!result?.welcome?.handoff) {
                    throw new Error('Target Zone ไม่ยืนยัน handoff');
                }

                await secureResumeHandoffOnTarget(targetSocket, targetZone, fromZone);
                if (operation) secureRequireHandoffOperation(operation);

                if (typeof secureForgetResumeTicket === 'function') secureForgetResumeTicket(fromZone);

                if (oldSocket && oldSocket !== targetSocket) {
                    secureCloseSocket(oldSocket, 1000, 'Zone handoff complete');
                }

                secureGameSocket = targetSocket;
                secureGameReady = true;
                secureCurrentZoneId = targetZone;
                secureLastMoveSentAt = 0;
                secureRememberStablePosition();
                secureHandoffInProgress = false;

                if (state.isPlaying && !state.isPaused) {
                    syncMyPlayerData(true);
                }
            } catch (err) {
                // Account/menu cancellation permanently fences this continuation.
                // It must not restore an old account's source or a newer game.
                if (operation && !secureHandoffOperationIsCurrent(operation)) return;
                if (operation?.continuous && typeof secureCancelContinuousHandoff === 'function') {
                    await secureCancelContinuousHandoff(operation, targetSocket, fromZone, err);
                    return;
                }
                console.warn('Smooth zone handoff interrupted:', err);

                if (err?.cancelledToSource && oldSocket && oldSocket.readyState === WebSocket.OPEN) {
                    if (targetSocket && targetSocket !== oldSocket) {
                        secureCloseSocket(targetSocket, 1000, 'Player returned to source zone');
                    }
                    try {
                        oldSocket.send(JSON.stringify({ type: protocol.WS_MESSAGE.HANDOFF_CANCEL }));
                    } catch (_) {}
                    secureGameSocket = oldSocket;
                    secureGameReady = true;
                    secureCurrentZoneId = fromZone;
                    secureHandoffInProgress = false;
                    secureLastMoveSentAt = 0;
                    secureRememberStablePosition();
                    syncMyPlayerData(true);
                    return;
                }

                console.error('Smooth zone handoff failed:', err);

                if (secureHandoffResumeTimer) clearTimeout(secureHandoffResumeTimer);
                secureHandoffResumeTimer = null;
                secureHandoffResumeResolve = null;
                secureHandoffResumeReject = null;

                if (targetSocket && targetSocket !== oldSocket) {
                    secureCloseSocket(targetSocket, 1000, 'Handoff rollback');
                }

                secureHandoffInProgress = false;

                // Restore the last confirmed source state while its cancellation
                // ACK supplies the durable rollback position and next sequence.
                if (oldSocket && oldSocket.readyState === WebSocket.OPEN) {
                    secureGameSocket = oldSocket;
                    secureGameReady = true;
                    secureCurrentZoneId = fromZone;
                    try {
                        oldSocket.send(JSON.stringify({ type: protocol.WS_MESSAGE.HANDOFF_CANCEL }));
                    } catch (_) {
                        secureCloseSocket(oldSocket, 1000, 'Handoff cancel failed');
                        secureReturnToMenu();
                        return;
                    }
                    playerPos.set(fallback.x, fallback.y, fallback.z);
                    playerRotation = fallback.r;
                    playerVel.x = 0;
                    playerVel.z = 0;
                    playerVelocityY = 0;
                    isGrounded = playerPos.y <= 0;
                    secureJumpHeld = false;
                    securePendingFrames.length = 0;
                    securePendingInputs.length = 0;
                    secureJumpIntent = false;
                    secureJumpGeneration++;
                    securePredictionCorrection.x = securePredictionCorrection.y = securePredictionCorrection.z = 0;
                    if (playerGroup) {
                        playerGroup.position.copy(playerPos);
                        playerGroup.rotation.y = playerRotation;
                    }
                    secureLastMoveSentAt = 0;
                    syncMyPlayerData(true);
                    alert('ย้าย Zone ไม่สำเร็จ ระบบพากลับตำแหน่งเดิม กรุณาลองอีกครั้ง');
                } else {
                    alert('ย้าย Zone ไม่สำเร็จและการเชื่อมต่อเดิมหลุด กรุณาเข้าเกมใหม่');
                    secureReturnToMenu();
                }
            } finally {
                if (operation && typeof secureFinishContinuousHandoff === 'function') secureFinishContinuousHandoff(operation);
                if (operation) secureFinishHandoffOperation(operation);
            }
        }

        async function secureConnectGameSocket() {
            if (!auth.currentUser) throw new Error('ต้องล็อกอิน Google ก่อนเข้าเล่น');
            if (!['free1', 'vip1'].includes(state.selectedServerId)) throw new Error('Server ไม่ถูกต้อง');
            if (typeof secureCancelReconnect === 'function') secureCancelReconnect();

            const existing = secureGameSocket;
            if (existing) {
                secureCloseSocket(existing, 1000, 'Reconnect');
                if (secureGameSocket === existing) secureGameSocket = null;
            }

            secureGameReady = false;
            secureHandoffInProgress = false;
            secureCurrentZoneId = secureZoneFromPosition(playerPos.x, playerPos.z) || '5,5';
            secureClearRemoteState();
            const result = await secureOpenZoneSocket(secureCurrentZoneId, '', true);
            secureRememberStablePosition();
            return result.welcome;
        }
