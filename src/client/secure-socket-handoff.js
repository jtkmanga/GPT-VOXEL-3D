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

        function secureSessionKey(zoneId, uid = auth.currentUser?.uid) {
            const zone = secureNormalizeZoneId(zoneId);
            return typeof uid === 'string' && uid && zone ? `${uid}:${zone}` : '';
        }

        function secureGetResumeTicket(zoneId, uid = auth.currentUser?.uid) {
            const key = secureSessionKey(zoneId, uid);
            const ticket = key && secureSessionTickets.get(key);
            if (!ticket || ticket.resumeExpiresAt <= secureNow()) {
                if (key) secureSessionTickets.delete(key);
                return null;
            }
            return ticket;
        }

        function secureRememberSession(zoneId, session) {
            const key = secureSessionKey(zoneId);
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
            secureRememberSession(zoneId, session);
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
                        protocol: protocol.PROTOCOL_VERSION.ZONE_ROOM
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

        async function secureResumeDisconnectedSocket(zoneId, uid) {
            if (secureReconnectInProgress || !secureGetResumeTicket(zoneId, uid)) return false;
            secureReconnectInProgress = true;
            const generation = ++secureReconnectGeneration;
            try {
                for (let attempt = 0; attempt < 3; attempt++) {
                    await secureClientDelay(250 * (2 ** attempt));
                    if (generation !== secureReconnectGeneration || !state.isPlaying ||
                        secureHandoffInProgress || secureGameSocket || auth.currentUser?.uid !== uid ||
                        !secureGetResumeTicket(zoneId, uid)) return false;
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
                    secureCurrentZoneId = secureNormalizeZoneId(message.zone) || secureCurrentZoneId;
                    state.serverPlayerId = String(message.id || '');
                    state.score = Number(message.score) || 0;
                    updateScoreDisplay();

                    // Initial login uses the server spawn normally. During a Zone handoff,
                    // keep the locally rendered position/velocity moving smoothly; the
                    // target Zone validates that current position with handoff_resume.
                    if (message.spawn && !isSmoothHandoffWelcome) {
                        playerPos.set(
                            Number(message.spawn.x) || 0,
                            Number(message.spawn.y) || 0,
                            Number(message.spawn.z) || 0
                        );
                        if (Number.isFinite(Number(message.spawn.r))) {
                            playerRotation = Number(message.spawn.r);
                        }
                        if (playerGroup) {
                            playerGroup.position.copy(playerPos);
                            playerGroup.rotation.y = playerRotation;
                        }
                        playerVel.x = 0;
                        playerVel.z = 0;
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

                    if (isSmoothHandoffWelcome) {
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
                    break;
                }
                case protocol.WS_MESSAGE.JOIN: {
                    const p = secureNormalizePlayer(message.player);
                    if (p.id && p.id !== state.serverPlayerId) secureTrackRemotePlayer(p.id, 'local', p);
                    break;
                }
                case protocol.WS_MESSAGE.MOVE: {
                    const p = secureNormalizePlayer(message.player);
                    if (!p.id || p.id === state.serverPlayerId) break;
                    secureTrackRemotePlayer(p.id, 'local', p);
                    break;
                }
                case protocol.WS_MESSAGE.LEAVE:
                    if (message.id) secureUntrackRemotePlayer(String(message.id), 'local');
                    break;
                case protocol.WS_MESSAGE.GHOST_SNAPSHOT:
                    secureReplaceGhostSnapshot(message);
                    break;
                case protocol.WS_MESSAGE.ZONE_CHANGE:
                    void secureBeginZoneHandoff(message);
                    break;
                case protocol.WS_MESSAGE.SCORE:
                    state.score = Number(message.score) || 0;
                    updateScoreDisplay();
                    break;
                case protocol.WS_MESSAGE.LEADERBOARD:
                    updateLeaderboardUI(secureNormalizeLeaderboard(message.top));
                    break;
                case protocol.WS_MESSAGE.COIN_COLLECT_RESULT: {
                    const id = Number(message?.id);
                    if (Number.isInteger(id) && id >= 0 && id < coins.length) {
                        const coin = coins[id];
                        coin._collectPendingUntil = 0;
                        if (message.collected) {
                            if (Number.isFinite(Number(message.score))) {
                                state.score = Number(message.score);
                                updateScoreDisplay();
                            }
                            if (message.event) secureUpdateCoinState(message.event);
                        } else {
                            if (message.serverNow) secureSetServerNow(message.serverNow);
                            const activeAfter = Number(message.activeAfter) || 0;
                            coin.respawnTime = activeAfter;
                            coin.active = activeAfter <= secureNow();
                            coin.mesh.visible = coin.active;
                        }
                    }
                    break;
                }
                case protocol.WS_MESSAGE.COIN_COLLECTED:
                case protocol.WS_MESSAGE.COIN_STATE:
                    secureUpdateCoinState(message);
                    break;
                case protocol.WS_MESSAGE.BOX_STATE:
                    secureApplyLuckyBoxState(message.box || message.luckyBox || message, message.serverNow);
                    break;
                case protocol.WS_MESSAGE.BOX_SPIN_READY:
                    secureApplyLuckyBoxState(message.box || message.luckyBox || null, message.serverNow);
                    triggerLuckyBoxModal();
                    break;
                case protocol.WS_MESSAGE.BOX_REWARD:
                    if (message.serverNow) secureSetServerNow(message.serverNow);
                    if (Number.isFinite(Number(message.score))) {
                        state.score = Number(message.score);
                        updateScoreDisplay();
                    }
                    secureAnimateWheelToReward(Number(message.reward) || 0);
                    break;
                case protocol.WS_MESSAGE.BOX_ERROR:
                    console.warn('Lucky Box:', message.message || message);
                    break;
                case protocol.WS_MESSAGE.HANDOFF_RESUMED:
                    if (message.serverNow) secureSetServerNow(message.serverNow);
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
                    if (secureHandoffResumeReject) secureHandoffResumeReject(err);
                    secureHandoffResumeResolve = null;
                    secureHandoffResumeReject = null;
                    break;
                }
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

        async function secureOpenZoneSocket(zoneId, handoffToken = '', forceTokenRefresh = false, requireResume = false) {
            if (!auth.currentUser) throw new Error('ต้องล็อกอิน Google ก่อนเข้าเล่น');
            const normalizedZone = secureNormalizeZoneId(zoneId);
            if (!normalizedZone) throw new Error('Zone ไม่ถูกต้อง');
            if (requireResume && (typeof secureGetResumeTicket !== 'function' || !secureGetResumeTicket(normalizedZone))) {
                throw new Error('Session เดิมหมดอายุ กรุณาเข้าเกมใหม่');
            }

            const user = auth.currentUser;
            const uid = user.uid;
            const connectionEpoch = typeof secureConnectionEpoch === 'function' ? secureConnectionEpoch() : null;
            const connectionCurrent = () => auth.currentUser === user && auth.currentUser?.uid === uid &&
                (connectionEpoch === null || typeof secureConnectionIsCurrent !== 'function' || secureConnectionIsCurrent(connectionEpoch));
            const token = await user.getIdToken(forceTokenRefresh);
            if (!connectionCurrent()) {
                throw new Error('บัญชีเปลี่ยนระหว่างเชื่อมต่อ Game Server');
            }

            return new Promise((resolve, reject) => {
                const ws = new WebSocket(secureZoneSocketUrl(normalizedZone));
                ws.secureAuthenticatedUid = uid;
                if (typeof secureRegisterClientSocket === 'function') secureRegisterClientSocket(ws);
                let welcomed = false;
                let settled = false;

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
                        protocol: protocol.PROTOCOL_VERSION.ZONE_ROOM,
                        name: String(state.playerName || 'Player').trim().slice(0, 12)
                    };
                    if (handoffToken) authMessage.handoffToken = String(handoffToken);
                    else if (typeof secureGetResumeTicket === 'function') {
                        const ticket = secureGetResumeTicket(normalizedZone, uid);
                        if (requireResume && !ticket) {
                            failBeforeWelcome('Session เดิมหมดอายุ กรุณาเข้าเกมใหม่');
                            return;
                        }
                        if (ticket) authMessage.resumeToken = ticket.resumeToken;
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
                            failBeforeWelcome(message.message || 'Game Server ปฏิเสธการเชื่อมต่อ');
                            return;
                        }
                        return;
                    }

                    if (ws === secureGameSocket) secureHandleSocketMessage(message);
                };

                ws.onerror = () => {
                    if (!welcomed) failBeforeWelcome('WebSocket Zone Server มีปัญหา');
                };

                ws.onclose = event => {
                    clearTimeout(timer);
                    if (typeof secureUnregisterClientSocket === 'function') secureUnregisterClientSocket(ws);
                    if (typeof secureClearSocketRefresh === 'function') secureClearSocketRefresh(ws);
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
                            void secureResumeDisconnectedSocket(normalizedZone, uid).then(resumed => {
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
                const liveZone = secureZoneFromPosition(playerPos.x, playerPos.z);
                if (liveZone === fromZone) {
                    const cancelled = new Error('ผู้เล่นกลับเข้า Zone เดิมระหว่าง handoff');
                    cancelled.cancelledToSource = true;
                    throw cancelled;
                }
                if (liveZone && liveZone !== targetZone) {
                    const movedTooFar = new Error('ผู้เล่นเคลื่อนผ่าน Zone เป้าหมายระหว่าง handoff');
                    movedTooFar.retryable = false;
                    throw movedTooFar;
                }

                const ackPromise = secureWaitForHandoffResumeAck(3200);
                ws.send(JSON.stringify({
                    type: protocol.WS_MESSAGE.HANDOFF_RESUME,
                    x: Math.round(playerPos.x * 100) / 100,
                    y: Math.round(playerPos.y * 100) / 100,
                    z: Math.round(playerPos.z * 100) / 100,
                    r: Math.round(playerRotation * 1000) / 1000
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
            if (secureHandoffInProgress || !state.isPlaying) return;

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

            // IMPORTANT: do not pause state.isPaused here. The local movement/camera
            // keeps rendering while the target Zone opens. Network-authoritative
            // position is reconciled by one validated handoff_resume message.
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

                // Rollback only happens on a genuine handoff failure. Normal successful
                // crossings never freeze or snap back.
                if (oldSocket && oldSocket.readyState === WebSocket.OPEN) {
                    secureGameSocket = oldSocket;
                    secureGameReady = true;
                    secureCurrentZoneId = fromZone;
                    playerPos.set(fallback.x, fallback.y, fallback.z);
                    playerRotation = fallback.r;
                    playerVel.x = 0;
                    playerVel.z = 0;
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
                if (operation) secureFinishHandoffOperation(operation);
            }
        }

        async function secureConnectGameSocket() {
            if (!auth.currentUser) throw new Error('ต้องล็อกอิน Google ก่อนเข้าเล่น');
            if (state.selectedServerId !== 'free1') throw new Error('Security Test เปิดเฉพาะ Free Server จนกว่า VIP room routing จะเสร็จ');
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
