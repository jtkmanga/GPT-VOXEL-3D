        // ============================================================
        // SECURE WORKER CLIENT OVERRIDES (2026-09-28)
        // Payment/entitlements + Free Server multiplayer + Coin + Lucky Box are server-authoritative.
        // VIP gameplay uses its separately admitted trusted room; purchases stay disabled in this rebuild.
        // ============================================================
        // FREE_10K_PHASE2C1_CLIENT
        // Free Server client now connects directly to the 10x10 ZoneRoom mesh,
        // performs secure one-time handoffs and consumes B2 ghost snapshots.
        // FREE_10K_PHASE2C1_1_SMOOTH_HANDOFF
        // Handoff no longer pauses the whole game loop. The target Zone validates
        // one server-authoritative handoff_resume before the source socket closes.
        // FREE_10K_PHASE2C2_MULTIPLAYER_FIX
        // Player-selected names now travel through the Worker, leaderboard updates
        // are global, handoff can cancel safely if the player steps back across the
        // border, and coin pickup uses instant visual prediction + fast server ACK.
        const SECURE_WORKER_HTTP_BASE = 'https://voxel-run-v2-demo.hjinffv5426.workers.dev';
        const SECURE_WORKER_WS_BASE = SECURE_WORKER_HTTP_BASE.replace(/^http/, 'ws') + '/play';
        const SECURE_PAYMENT_PROMPTPAY_TARGET = '0999999999'; // MUST match PAYMENT_RECEIVER_ACCOUNT before public launch.
        const SECURE_ZONE_GRID_SIZE = config.ZONE_GRID_SIZE;
        const SECURE_ZONE_SIZE = config.ZONE_SIZE;

        let secureGameSocket = null;
        let secureGameReady = false;
        let secureLastMoveSentAt = 0;
        let secureServerTimeOffset = 0;
        let secureEntitlementRefreshTimer = null;
        let secureCurrentZoneId = null;
        let secureHandoffInProgress = false;
        let secureHandoffResumeResolve = null;
        let secureHandoffResumeReject = null;
        let secureHandoffResumeTimer = null;
        let secureLastStablePosition = { x: 0, y: 0, z: 0, r: 0 };
        const secureIntentionalSockets = new WeakSet();
        const secureRemoteSources = new Map();
        const secureGhostMembersByZone = new Map();
        let secureIdentityUid = null;

        function secureOnIdentityChanged(user) {
            const nextUid = typeof user?.uid === 'string' ? user.uid : null;
            if (secureIdentityUid === nextUid) return;
            secureIdentityUid = nextUid;
            state.shop.speedBuffExpires = 0;
            state.shop.coinBuffExpires = 0;
            state.userVipSubscriptions = {};
            if (typeof secureCancelReconnect === 'function') secureCancelReconnect();
            if (typeof secureSessionTickets !== 'undefined') secureSessionTickets.clear();
            if (typeof secureAbortClientConnections === 'function') {
                secureAbortClientConnections('Account changed', 1008);
            } else if (secureGameSocket && secureGameSocket.secureAuthenticatedUid !== nextUid) {
                const ws = secureGameSocket;
                if (typeof secureClearSocketRefresh === 'function') secureClearSocketRefresh(ws);
                secureCloseSocket(ws, 1008, 'Account changed');
                if (secureGameSocket === ws) secureGameSocket = null;
            }
            if (state.isPlaying) secureReturnToMenu();
            if (!nextUid && secureEntitlementRefreshTimer) {
                clearInterval(secureEntitlementRefreshTimer);
                secureEntitlementRefreshTimer = null;
            }
        }

        function secureNow() {
            return Date.now() + secureServerTimeOffset;
        }

        function secureSetServerNow(serverNow) {
            const n = Number(serverNow);
            if (Number.isFinite(n) && n > 0) {
                secureServerTimeOffset = n - Date.now();
            }
        }

        function secureNormalizeEntitlements(raw = {}) {
            return {
                speedExpires: Number(raw.speedExpires ?? raw.speed_expires ?? 0) || 0,
                coinExpires: Number(raw.coinExpires ?? raw.coin_expires ?? 0) || 0,
                vip1Expires: Number(raw.vip1Expires ?? raw.vip1_expires ?? 0) || 0
            };
        }

        function secureApplyEntitlements(rawEntitlements = {}, serverInfo = null, serverNow = null) {
            if (serverNow) secureSetServerNow(serverNow);
            const ent = secureNormalizeEntitlements(rawEntitlements);
            state.shop.speedBuffExpires = ent.speedExpires;
            state.shop.coinBuffExpires = ent.coinExpires;
            state.userVipSubscriptions = ent.vip1Expires > secureNow()
                ? { vip1: { expireTime: ent.vip1Expires } }
                : {};

            if (serverInfo?.vip1) {
                state.vipServers.vip1.count = Math.max(0, Number(serverInfo.vip1.count) || 0);
                state.vipServers.vip1.max = Math.max(1, Number(serverInfo.vip1.max) || config.VIP_ENTITLEMENT_CAP);
            }

            updateShopUI();
            renderServersUI();
        }

        async function secureLoadEntitlements(forceTokenRefresh = false) {
            const user = auth.currentUser;
            if (!user) {
                state.shop.speedBuffExpires = 0;
                state.shop.coinBuffExpires = 0;
                state.userVipSubscriptions = {};
                state.vipServers.vip1.count = 0;
                renderServersUI();
                updateShopUI();
                return null;
            }

            const uid = user.uid;
            const token = await user.getIdToken(forceTokenRefresh);
            if (auth.currentUser !== user || auth.currentUser?.uid !== uid) {
                throw new Error('บัญชีเปลี่ยนระหว่างตรวจสอบสิทธิ์');
            }
            const response = await fetch(SECURE_WORKER_HTTP_BASE + '/entitlements', {
                method: 'GET',
                headers: { 'Authorization': 'Bearer ' + token }
            });
            const result = await response.json().catch(() => ({}));
            if (!response.ok || !result?.ok) {
                throw new Error(result?.error || 'ไม่สามารถโหลดสิทธิ์จาก Server ได้');
            }
            if (auth.currentUser !== user || auth.currentUser?.uid !== uid) {
                throw new Error('บัญชีเปลี่ยนระหว่างตรวจสอบสิทธิ์');
            }

            secureApplyEntitlements(result.entitlements, result.servers, result.serverNow);
            return result;
        }

        // Legacy localStorage buffs are intentionally ignored and removed.
        loadSavedBuffs = function() {
            localStorage.removeItem('voxel_shop_speed_expire');
            localStorage.removeItem('voxel_shop_coin_expire');
            state.shop.speedBuffExpires = 0;
            state.shop.coinBuffExpires = 0;
        };

        loadScoreForCurrentId = function() {
            // Competitive score comes only from the Worker welcome/score messages.
            if (!secureGameReady) state.score = 0;
            updateScoreDisplay();
        };

        addScore = function() {
            console.warn('Blocked client-side score mutation: score is server-authoritative.');
        };

        resetHighScore = function() {
            console.warn('Blocked client-side score reset: score is server-authoritative.');
        };

        listenToVipServersRealtime = function() {
            // VIP counts come from /entitlements, not writable Firebase membership data.
            if (auth.currentUser) {
                secureLoadEntitlements().catch(err => console.warn('Entitlement refresh:', err));
            }
        };

        listenToUserVipStatus = function() {
            secureLoadEntitlements(true).catch(err => {
                console.error('Entitlement load failed:', err);
                state.userVipSubscriptions = {};
                state.shop.speedBuffExpires = 0;
                state.shop.coinBuffExpires = 0;
                renderServersUI();
                updateShopUI();
            });

            if (secureEntitlementRefreshTimer) clearInterval(secureEntitlementRefreshTimer);
            secureEntitlementRefreshTimer = setInterval(() => {
                if (auth.currentUser) {
                    secureLoadEntitlements().catch(() => {});
                }
            }, 60_000);
        };

        const SECURE_PAYMENT_ITEMS = catalog.CLIENT_PAYMENT_ITEMS;

        openPaymentModal = function(type, _price, title) {
            if (!state.isLoggedIn || !auth.currentUser) {
                alert('กรุณาล็อกอินด้วย Google Account ก่อนทำรายการ');
                return;
            }

            if (type === 'vip1') {
                alert('การชำระเงิน VIP ยังไม่เปิดใช้งาน: ราคา 50 บาท/เดือน ต้องยืนยันผู้ให้บริการชำระเงินก่อน');
                return;
            }

            const cfg = SECURE_PAYMENT_ITEMS[type];
            if (!cfg) {
                alert('รายการสินค้าไม่ถูกต้อง');
                return;
            }

            state.pendingPayment = { type, price: cfg.price, title: title || cfg.title };
            document.getElementById('pay-item-title').innerText = state.pendingPayment.title;
            document.getElementById('pay-item-price').innerText = cfg.price + ' บาท';
            document.getElementById('promptpay-qr-img').src = `https://promptpay.io/${SECURE_PAYMENT_PROMPTPAY_TARGET}/${cfg.price}.png`;
            document.getElementById('slip-file-input').value = '';
            document.getElementById('payment-modal').classList.remove('hidden');
        };

        verifyAndBuySlip = async function() {
            const user = auth.currentUser;
            if (!user) {
                alert('กรุณาล็อกอินใหม่ก่อนตรวจสอบสลิป');
                return;
            }

            const item = state.pendingPayment?.type;
            if (!SECURE_PAYMENT_ITEMS[item] || item === 'vip1') {
                alert('รายการชำระเงินนี้ยังไม่เปิดใช้งานใน Security Test');
                return;
            }

            const fileInput = document.getElementById('slip-file-input');
            if (!fileInput.files || fileInput.files.length === 0) {
                alert('กรุณาอัปโหลดรูปภาพสลิปก่อนตรวจสอบ');
                return;
            }

            const btnVerify = document.getElementById('btn-verify-slip');
            btnVerify.disabled = true;
            btnVerify.innerHTML = `<i class="fa-solid fa-spinner animate-spin"></i> กำลังตรวจสอบกับ Server...`;

            try {
                const token = await user.getIdToken(true);
                const formData = new FormData();
                formData.append('file', fileInput.files[0]);
                formData.append('item', item);

                const response = await fetch(SECURE_WORKER_HTTP_BASE + '/verify-slip', {
                    method: 'POST',
                    headers: { 'Authorization': 'Bearer ' + token },
                    body: formData
                });
                const result = await response.json().catch(() => ({}));

                if (!response.ok || !result?.ok || !result?.verified) {
                    if (response.status === 409 || result?.duplicate) {
                        throw new Error('สลิปนี้ถูกใช้รับสิทธิ์ไปแล้ว');
                    }
                    throw new Error(result?.error || 'ตรวจสอบสลิปไม่ผ่าน');
                }

                secureApplyEntitlements(result.entitlements, null, null);
                await secureLoadEntitlements().catch(() => null);

                alert(item === 'speed'
                    ? 'ชำระเงินสำเร็จ! Speed ×2 ถูกบันทึกบน Server 24 ชั่วโมง'
                    : 'ชำระเงินสำเร็จ! Coin ×2 ถูกบันทึกบน Server 24 ชั่วโมง');

                closePaymentModal();
                closeShopModal();
            } catch (error) {
                console.error('Secure payment error:', error);
                alert('การตรวจสอบสลิปไม่ผ่าน: ' + (error?.message || 'เกิดข้อผิดพลาด'));
            } finally {
                btnVerify.disabled = false;
                btnVerify.innerHTML = `<i class="fa-solid fa-shield-check"></i> <span>ตรวจสอบสลิปและรับสิทธิ์</span>`;
            }
        };

        grantPurchasedItem = function() {
            console.warn('Blocked grantPurchasedItem(): paid entitlements can only be granted by the Worker.');
            return false;
        };

        selectVipServer = async function(serverId = 'vip1') {
            if (serverId !== 'vip1' || !auth.currentUser) return false;
            const user = auth.currentUser;
            let result;
            try {
                result = await secureLoadEntitlements(true);
            } catch (err) {
                alert('ตรวจสอบสิทธิ์ VIP กับ Server ไม่สำเร็จ: ' + err.message);
                return false;
            }

            const expiry = Number(result?.entitlements?.vip1Expires ?? result?.entitlements?.vip1_expires ?? 0);
            if (auth.currentUser !== user || !Number.isFinite(expiry) || expiry <= secureNow()) {
                alert('คุณยังไม่มีสิทธิ์ VIP ที่ใช้งานได้');
                return false;
            }

            state.selectedServerId = 'vip1';
            renderServersUI();
            return true;
        };
