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
                case protocol.WS_MESSAGE.SERVER_ERROR:
                    console.error('Game server error:', message.message || message);
                    break;
            }
        }

        async function secureOpenZoneSocket(zoneId, handoffToken = '', forceTokenRefresh = false) {
            if (!auth.currentUser) throw new Error('ต้องล็อกอิน Google ก่อนเข้าเล่น');
            const normalizedZone = secureNormalizeZoneId(zoneId);
            if (!normalizedZone) throw new Error('Zone ไม่ถูกต้อง');

            const token = await auth.currentUser.getIdToken(forceTokenRefresh);

            return new Promise((resolve, reject) => {
                const ws = new WebSocket(secureZoneSocketUrl(normalizedZone));
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
                    const authMessage = {
                        type: protocol.WS_MESSAGE.AUTH,
                        token,
                        name: String(state.playerName || 'Player').trim().slice(0, 12)
                    };
                    if (handoffToken) authMessage.handoffToken = String(handoffToken);
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
                        if (message?.type === protocol.WS_MESSAGE.WELCOME) {
                            welcomed = true;
                            settled = true;
                            clearTimeout(timer);
                            secureGameSocket = ws;
                            secureGameReady = true;
                            secureCurrentZoneId = secureNormalizeZoneId(message.zone) || normalizedZone;
                            secureHandleSocketMessage(message);
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
                        alert('การเชื่อมต่อ Game Server หลุด กรุณาเข้าเกมใหม่');
                        secureReturnToMenu();
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
                    await new Promise(resolve => setTimeout(resolve, 120));
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
            let targetSocket = null;
            secureHandoffInProgress = true;

            // IMPORTANT: do not pause state.isPaused here. The local movement/camera
            // keeps rendering while the target Zone opens. Network-authoritative
            // position is reconciled by one validated handoff_resume message.
            try {
                const result = await secureOpenZoneSocket(targetZone, handoffToken, false);
                targetSocket = result?.ws || secureGameSocket;

                if (!result?.welcome?.handoff) {
                    throw new Error('Target Zone ไม่ยืนยัน handoff');
                }

                await secureResumeHandoffOnTarget(targetSocket, targetZone, fromZone);

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
            }
        }

        async function secureConnectGameSocket() {
            if (!auth.currentUser) throw new Error('ต้องล็อกอิน Google ก่อนเข้าเล่น');
            if (state.selectedServerId !== 'free1') throw new Error('Security Test เปิดเฉพาะ Free Server จนกว่า VIP room routing จะเสร็จ');

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
