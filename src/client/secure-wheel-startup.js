        function secureAnimateWheelToReward(rewardValue) {
            const animation = {};
            state.wheelAnimation = animation;
            const selectedIdx = WHEEL_ITEMS.findIndex(item => item.value === rewardValue);
            if (selectedIdx < 0) {
                state.wheelSpinning = false;
                document.getElementById('wheel-result-msg').innerText = 'Server ส่งผลรางวัลไม่ถูกต้อง';
                return;
            }

            state.wheelReward = WHEEL_ITEMS[selectedIdx];
            const sliceAngle = (2 * Math.PI) / WHEEL_ITEMS.length;
            const targetSliceAngle = selectedIdx * sliceAngle + sliceAngle / 2;
            const fullRotations = 5 * 2 * Math.PI;
            const targetAngle = fullRotations + (3 * Math.PI / 2 - targetSliceAngle);
            const startAngle = currentWheelAngle % (2 * Math.PI);
            const totalDelta = targetAngle - startAngle;
            const duration = 4000;
            const startTime = performance.now();
            let lastTickAngle = startAngle;

            document.getElementById('wheel-result-msg').innerText = 'กำลังหมุนวงล้อ...';

            function animateSpin(now) {
                if (state.wheelAnimation !== animation || !state.isPlaying) return;
                const elapsed = now - startTime;
                const progress = Math.min(elapsed / duration, 1);
                const easeOut = 1 - Math.pow(1 - progress, 3);
                currentWheelAngle = startAngle + totalDelta * easeOut;

                if (Math.abs(currentWheelAngle - lastTickAngle) > sliceAngle) {
                    audio.playWheelTick();
                    lastTickAngle = currentWheelAngle;
                }

                drawLuckyWheel();

                if (progress < 1) {
                    requestAnimationFrame(animateSpin);
                } else {
                    state.wheelSpinning = false;
                    audio.playReward();
                    document.getElementById('wheel-result-msg').innerHTML = `
                        <span class="text-amber-400 font-extrabold text-xl animate-bounce">
                            ยินดีด้วย! คุณได้รับ +${rewardValue.toLocaleString()} เหรียญ!
                        </span>`;
                    document.getElementById('btn-close-wheel').classList.remove('hidden');
                }
            }
            requestAnimationFrame(animateSpin);
        }

        startGame = async function() {
            if (!state.selectedServerId) {
                alert('กรุณาเลือกเซิร์ฟเวอร์ก่อนเริ่มเล่น');
                return;
            }
            if (!auth.currentUser) {
                alert('Security Test ต้องล็อกอิน Google ก่อนเข้าเล่น เพื่อให้ Server ยืนยันตัวตนและคะแนน');
                return;
            }
            const selectedServerId = state.selectedServerId;
            const user = auth.currentUser;
            if (typeof secureAbortClientConnections === 'function') secureAbortClientConnections('Starting game');
            const connectionEpoch = typeof secureConnectionEpoch === 'function' ? secureConnectionEpoch() : null;
            const startCurrent = () => auth.currentUser === user && state.selectedServerId === selectedServerId &&
                (connectionEpoch === null || secureConnectionIsCurrent(connectionEpoch));

            const inputName = document.getElementById('input-username').value.trim();
            if (inputName) state.playerName = inputName;

            const btn = document.getElementById('btn-start-game');
            const oldHtml = btn?.innerHTML;
            if (btn) {
                btn.disabled = true;
                btn.innerHTML = `<i class="fa-solid fa-spinner animate-spin"></i><span>กำลังเชื่อมต่อ Server...</span>`;
            }

            try {
                initServerMapData(config.SERVER_WORLD_SEED);
                const result = await secureLoadEntitlements().catch(error => {
                    if (selectedServerId === 'vip1') throw error;
                    return null;
                });
                if (selectedServerId === 'vip1') {
                    const expiry = Number(result?.entitlements?.vip1Expires ?? result?.entitlements?.vip1_expires ?? 0);
                    if (!Number.isFinite(expiry) || expiry <= secureNow()) throw new Error('สิทธิ์ VIP หมดอายุหรือถูกยกเลิก');
                }
                if (!startCurrent()) throw new Error('Session เปลี่ยนระหว่างเข้าเกม');
                await secureConnectGameSocket();
                if (!startCurrent()) throw new Error('Session เปลี่ยนระหว่างเข้าเกม');

                if (screen.orientation && screen.orientation.lock) {
                    screen.orientation.lock('landscape').catch(() => {});
                }

                document.getElementById('start-screen').classList.add('hidden');
                document.getElementById('game-hud').classList.remove('hidden');
                document.getElementById('player-nametag').classList.remove('hidden');
                document.getElementById('nametag-text').innerText = state.playerName;
                document.getElementById('player-nametag').style.display = 'none';

                state.isPlaying = true;
                state.isPaused = false;
                audio.playStart();
                syncMyPlayerData(true);
            } catch (err) {
                console.error('Start secure game failed:', err);
                if (!startCurrent()) return;
                if (secureGameSocket) secureCloseSocket(secureGameSocket, 1000, 'Start failed');
                secureGameSocket = null;
                secureGameReady = false;
                alert('เข้าเกมไม่สำเร็จ: ' + (err?.message || 'Game Server error'));
            } finally {
                if (btn && startCurrent()) {
                    btn.disabled = false;
                    btn.innerHTML = oldHtml || `<i class="fa-solid fa-gamepad"></i><span>เริ่มเล่นเกม</span>`;
                }
            }
        };

        confirmExitGame = function() {
            if (typeof secureAbortClientConnections === 'function') secureAbortClientConnections('Exit game');
            const ws = secureGameSocket;
            secureGameSocket = null;
            secureGameReady = false;
            secureHandoffInProgress = false;
            if (secureHandoffResumeTimer) clearTimeout(secureHandoffResumeTimer);
            secureHandoffResumeTimer = null;
            secureHandoffResumeResolve = null;
            secureHandoffResumeReject = null;
            if (ws) secureCloseSocket(ws, 1000, 'Bye');
            if (luckyBoxServerRef) {
                try { luckyBoxServerRef.off(); } catch (_) {}
            }
            secureReturnToMenu();
        };


        init3D();
        loadSavedBuffs();
        listenToVipServersRealtime();
        gameLoop();
