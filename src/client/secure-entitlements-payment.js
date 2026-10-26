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
            const sample = secureSetServerNow.sample;
            if (sample) {
                const tick = typeof performance !== 'undefined' && typeof performance.now === 'function'
                    ? performance.now() : Date.now();
                return sample.server + Math.max(0, tick - sample.tick);
            }
            return Date.now() + secureServerTimeOffset;
        }

        function secureSetServerNow(serverNow) {
            const n = Number(serverNow);
            if (!Number.isFinite(n) || n <= 0 || n <= (secureSetServerNow.sample?.latest || 0)) return false;
            const server = secureSetServerNow.sample ? Math.max(n, secureNow()) : n;
            const tick = typeof performance !== 'undefined' && typeof performance.now === 'function'
                ? performance.now() : Date.now();
            secureSetServerNow.sample = { latest: n, server, tick };
            secureServerTimeOffset = server - Date.now();
            return true;
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
            const headers = { 'Authorization': 'Bearer ' + token };
            if (typeof secureGetAppCheckToken === 'function') {
                headers['X-Firebase-AppCheck'] = await secureGetAppCheckToken(false);
            }
            const response = await fetch(SECURE_WORKER_HTTP_BASE + '/entitlements', {
                method: 'GET', headers
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
        // VIP payments use server-generated 2C2P PPQR only; no static receiver is embedded in the client.
        const secureBaseClosePaymentModal = typeof closePaymentModal === 'function'
            ? closePaymentModal
            : function() {
                const modal = typeof document !== 'undefined' ? document.getElementById('payment-modal') : null;
                if (modal?.classList) modal.classList.add('hidden');
            };
        let securePromptPayPollTimer = null;
        let securePromptPayPolling = false;

        function securePromptPayUiStatus(message, tone = 'normal') {
            const box = document.getElementById('promptpay-payment-status');
            if (!box) return;
            box.innerText = message;
            box.classList.toggle('text-emerald-300', tone === 'success');
            box.classList.toggle('text-rose-300', tone === 'error');
            box.classList.toggle('text-slate-300', tone === 'normal');
        }

        async function securePromptPayHeaders(user, forceRefresh = false) {
            const uid = user?.uid;
            const token = await user.getIdToken(forceRefresh);
            if (!uid || auth.currentUser !== user || auth.currentUser?.uid !== uid) {
                throw new Error('บัญชีเปลี่ยนระหว่างทำรายการ');
            }
            const headers = { 'Authorization': 'Bearer ' + token };
            if (typeof secureGetAppCheckToken === 'function') {
                headers['X-Firebase-AppCheck'] = await secureGetAppCheckToken(false);
            }
            return headers;
        }

        function secureStopPromptPayPolling() {
            if (securePromptPayPollTimer) clearTimeout(securePromptPayPollTimer);
            securePromptPayPollTimer = null;
        }

        function secureSchedulePromptPayPoll() {
            secureStopPromptPayPolling();
            securePromptPayPollTimer = setTimeout(() => {
                secureRefreshPromptPayStatus(false).catch(() => {});
            }, 5000);
        }

        async function secureRefreshPromptPayStatus(manual = false) {
            if (securePromptPayPolling) return null;
            const user = auth.currentUser;
            const invoiceNo = state.pendingPayment?.invoiceNo;
            if (typeof liveSiteConfig === 'undefined' || liveSiteConfig?.promptPayEnabled !== true) {
                secureStopPromptPayPolling();
                if (manual) alert('PromptPay ยังไม่เปิดรับเงินจริงในขณะนี้');
                return null;
            }
            if (!user || state.pendingPayment?.type !== 'vip1' || typeof invoiceNo !== 'string') {
                if (manual) alert('ไม่พบรายการ PromptPay ที่กำลังรอชำระ');
                return null;
            }
            securePromptPayPolling = true;
            const button = document.getElementById('btn-verify-slip');
            if (manual && button) {
                button.disabled = true;
                button.innerHTML = '<i class="fa-solid fa-spinner animate-spin"></i> <span>กำลังตรวจสอบ...</span>';
            }
            try {
                const headers = await securePromptPayHeaders(user, manual);
                const response = await fetch(SECURE_WORKER_HTTP_BASE + '/payments/promptpay/status?invoiceNo=' +
                    encodeURIComponent(invoiceNo), { method: 'GET', headers });
                const result = await response.json().catch(() => ({}));
                if (!response.ok || !result?.ok) throw new Error(result?.error || 'ตรวจสอบสถานะ PromptPay ไม่สำเร็จ');
                if (result.status === 'paid') {
                    secureStopPromptPayPolling();
                    await secureLoadEntitlements(true);
                    securePromptPayUiStatus('ชำระเงินสำเร็จ — เปิดสิทธิ์ VIP แล้ว', 'success');
                    alert('ชำระเงินสำเร็จ! สิทธิ์ VIP ถูกบันทึกบน Server แล้ว');
                    closePaymentModal();
                    closeShopModal();
                    return result;
                }
                if (['failed', 'cancelled', 'expired'].includes(result.status)) {
                    secureStopPromptPayPolling();
                    securePromptPayUiStatus('รายการนี้สิ้นสุดแล้ว: ' + result.status, 'error');
                    if (manual) alert('รายการ PromptPay ไม่สามารถชำระต่อได้ กรุณาสร้าง QR ใหม่');
                    return result;
                }
                securePromptPayUiStatus('รอการชำระเงินและการยืนยันจาก 2C2P...');
                secureSchedulePromptPayPoll();
                return result;
            } catch (error) {
                securePromptPayUiStatus(error?.message || 'ตรวจสอบ PromptPay ไม่สำเร็จ', 'error');
                if (manual) alert(error?.message || 'ตรวจสอบ PromptPay ไม่สำเร็จ');
                else secureSchedulePromptPayPoll();
                return null;
            } finally {
                securePromptPayPolling = false;
                if (manual && button) {
                    button.disabled = false;
                    button.innerHTML = '<i class="fa-solid fa-rotate"></i> <span>ตรวจสอบสถานะการชำระเงิน</span>';
                }
            }
        }

        async function secureBeginPromptPayVipCheckout(title) {
            const user = auth.currentUser;
            if (!user) throw new Error('กรุณาล็อกอินด้วย Google Account ก่อนทำรายการ');
            if (typeof liveSiteConfig === 'undefined' || liveSiteConfig?.promptPayEnabled !== true)
                throw new Error('PromptPay ยังไม่เปิดรับเงินจริงในขณะนี้');
            if (liveSiteConfig?.paymentPaused) {
                throw new Error('ระบบชำระเงินถูกพักชั่วคราว');
            }
            const livePricing = typeof liveSiteConfig !== 'undefined' ? liveSiteConfig?.pricing : null;
            const configured = Number(livePricing?.vip1);
            const fallback = SECURE_PAYMENT_ITEMS.vip1.price;
            const displayedPrice = Number.isSafeInteger(configured) && configured > 0 ? configured : fallback;
            state.pendingPayment = { type: 'vip1', price: displayedPrice,
                title: title || SECURE_PAYMENT_ITEMS.vip1.title };
            document.getElementById('pay-item-title').innerText = state.pendingPayment.title;
            document.getElementById('pay-item-price').innerText = displayedPrice + ' บาท';
            const image = document.getElementById('promptpay-qr-img');
            image.src = '';
            image.referrerPolicy = 'no-referrer';
            document.getElementById('promptpay-qr-wrap').classList.add('hidden');
            securePromptPayUiStatus('กำลังสร้าง PromptPay Dynamic QR จาก 2C2P...');
            document.getElementById('payment-modal').classList.remove('hidden');

            const headers = await securePromptPayHeaders(user, true);
            headers['Content-Type'] = 'application/json';
            const requestId = 'vip1ppqr:' + crypto.randomUUID().replace(/-/g, '');
            const response = await fetch(SECURE_WORKER_HTTP_BASE + '/payments/promptpay/checkout', {
                method: 'POST',
                headers,
                body: JSON.stringify({ requestId })
            });
            const result = await response.json().catch(() => ({}));
            if (!response.ok || !result?.ok) {
                if (response.status === 503) throw new Error('PromptPay ยังไม่เปิดรับเงินจริงในขณะนี้');
                throw new Error(result?.error || 'สร้าง PromptPay QR ไม่สำเร็จ');
            }
            if (result.paymentChannel !== 'PPQR' || typeof result.invoiceNo !== 'string' ||
                typeof result.qrImageUrl !== 'string' || !result.qrImageUrl.startsWith('https://')) {
                throw new Error('ข้อมูล PromptPay QR จาก Server ไม่ถูกต้อง');
            }
            if (auth.currentUser !== user) throw new Error('บัญชีเปลี่ยนระหว่างทำรายการ');
            state.pendingPayment = {
                ...state.pendingPayment,
                invoiceNo: result.invoiceNo,
                expiresAt: Number(result.expiresAt) || 0,
                price: Number(result.amount) || displayedPrice
            };
            document.getElementById('pay-item-price').innerText = state.pendingPayment.price + ' บาท';
            image.src = result.qrImageUrl;
            document.getElementById('promptpay-qr-wrap').classList.remove('hidden');
            securePromptPayUiStatus('สแกน QR ด้วยแอปธนาคารไทย แล้วรอ Server ยืนยันอัตโนมัติ');
            secureSchedulePromptPayPoll();
            return result;
        }

        closePaymentModal = function() {
            secureStopPromptPayPolling();
            securePromptPayPolling = false;
            state.pendingPayment = null;
            secureBaseClosePaymentModal();
        };

        openPaymentModal = function(type, _price, title) {
            if (!state.isLoggedIn || !auth.currentUser) {
                alert('กรุณาล็อกอินด้วย Google Account ก่อนทำรายการ');
                return;
            }
            if (type !== 'vip1') {
                alert('รายการนี้ยังไม่เปิดรับชำระเงินจริง ระบบ PromptPay เปิดสำหรับ VIP เท่านั้น');
                return;
            }
            if (typeof liveSiteConfig === 'undefined' || liveSiteConfig?.promptPayEnabled !== true) {
                alert('PromptPay ยังไม่เปิดรับเงินจริงในขณะนี้');
                return;
            }
            secureBeginPromptPayVipCheckout(title).catch(error => {
                secureStopPromptPayPolling();
                securePromptPayUiStatus(error?.message || 'สร้าง PromptPay QR ไม่สำเร็จ', 'error');
                console.error('PromptPay checkout failed:', error);
            });
        };

        verifyAndBuySlip = async function() {
            await secureRefreshPromptPayStatus(true);
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
