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
        let securePromptPayPollTimer = null;
        let securePromptPayInvoice = null;
        const secureBaseClosePaymentModal = typeof closePaymentModal === 'function' ? closePaymentModal : null;

        function secureSetPromptPayModal(active) {
            const slip = document.getElementById('payment-slip-section');
            const verify = document.getElementById('btn-verify-slip');
            const account = document.getElementById('payment-account-info');
            if (slip?.classList) active ? slip.classList.add('hidden') : slip.classList.remove('hidden');
            if (verify?.classList) active ? verify.classList.add('hidden') : verify.classList.remove('hidden');
            if (account) account.innerText = active
                ? 'Dynamic QR · สร้างใหม่ต่อรายการ · ไม่ต้องอัปโหลดสลิป'
                : 'ชำระเงินตาม QR และอัปโหลดสลิปเพื่อตรวจสอบ';
        }

        async function securePaymentHeaders(user, refresh = false) {
            const token = await user.getIdToken(refresh);
            if (auth.currentUser !== user) throw new Error('บัญชีเปลี่ยนระหว่างชำระเงิน');
            const appCheckToken = typeof secureGetAppCheckToken === 'function'
                ? await secureGetAppCheckToken(false) : '';
            return {
                'Authorization': 'Bearer ' + token,
                ...(appCheckToken ? { 'X-Firebase-AppCheck': appCheckToken } : {})
            };
        }

        function securePromptPayRequestId() {
            const nonce = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
                ? crypto.randomUUID().replace(/-/g, '')
                : (Date.now().toString(36) + Math.random().toString(36).slice(2));
            return ('vip1pp:' + nonce).slice(0, 96);
        }

        async function securePollPromptPayStatus(user, invoiceNo) {
            if (!user || auth.currentUser !== user || securePromptPayInvoice !== invoiceNo) return false;
            try {
                const headers = await securePaymentHeaders(user, false);
                const response = await fetch(SECURE_WORKER_HTTP_BASE + '/payments/promptpay/status?invoiceNo=' +
                    encodeURIComponent(invoiceNo), { method: 'GET', headers });
                const result = await response.json().catch(() => ({}));
                if (!response.ok || !result?.ok) return false;
                const status = document.getElementById('payment-status');
                if (result.status === 'paid') {
                    if (status) status.innerText = 'ชำระเงินสำเร็จ · กำลังเปิดสิทธิ์ VIP';
                    if (securePromptPayPollTimer) clearInterval(securePromptPayPollTimer);
                    securePromptPayPollTimer = null;
                    await secureLoadEntitlements(true);
                    alert('ชำระเงินสำเร็จ! เปิดสิทธิ์ VIP Server 30 วันแล้ว');
                    closePaymentModal();
                    closeShopModal();
                    return true;
                }
                if (['failed', 'cancelled', 'expired'].includes(result.status)) {
                    if (status) status.innerText = 'รายการหมดอายุหรือไม่สำเร็จ กรุณาสร้าง QR ใหม่';
                    if (securePromptPayPollTimer) clearInterval(securePromptPayPollTimer);
                    securePromptPayPollTimer = null;
                    return false;
                }
                if (status) status.innerText = 'รอธนาคารยืนยันการชำระเงิน…';
            } catch (_) {}
            return false;
        }

        async function secureStartPromptPayCheckout(title) {
            const user = auth.currentUser;
            if (!state.isLoggedIn || !user) {
                alert('กรุณาล็อกอินด้วย Google Account ก่อนทำรายการ');
                return false;
            }
            const livePricing = typeof liveSiteConfig !== 'undefined' ? liveSiteConfig?.pricing : null;
            const configured = Number(livePricing?.vip1);
            const price = Number.isSafeInteger(configured) && configured > 0
                ? configured : SECURE_PAYMENT_ITEMS.vip1.price;
            state.pendingPayment = { type: 'vip1', price, title: title || SECURE_PAYMENT_ITEMS.vip1.title };
            document.getElementById('pay-item-title').innerText = state.pendingPayment.title;
            document.getElementById('pay-item-price').innerText = price + ' บาท / 30 วัน';
            document.getElementById('promptpay-qr-img').src = '';
            const status = document.getElementById('payment-status');
            if (status) status.innerText = 'กำลังสร้าง PromptPay Dynamic QR…';
            secureSetPromptPayModal(true);
            document.getElementById('payment-modal').classList.remove('hidden');
            try {
                const headers = await securePaymentHeaders(user, true);
                headers['Content-Type'] = 'application/json';
                const response = await fetch(SECURE_WORKER_HTTP_BASE + '/payments/promptpay/checkout', {
                    method: 'POST', headers, body: JSON.stringify({ requestId: securePromptPayRequestId() })
                });
                const result = await response.json().catch(() => ({}));
                if (!response.ok || !result?.ok || typeof result.invoiceNo !== 'string' ||
                    typeof result.qrImageUrl !== 'string') {
                    throw new Error(result?.error || 'ไม่สามารถสร้าง PromptPay QR ได้');
                }
                const qr = new URL(result.qrImageUrl);
                if (qr.protocol !== 'https:') throw new Error('QR URL ไม่ปลอดภัย');
                if (auth.currentUser !== user) throw new Error('บัญชีเปลี่ยนระหว่างชำระเงิน');
                securePromptPayInvoice = result.invoiceNo;
                document.getElementById('promptpay-qr-img').src = qr.href;
                if (status) status.innerText = 'สแกน QR ด้วยแอปธนาคาร แล้วระบบจะยืนยันอัตโนมัติ';
                if (securePromptPayPollTimer) clearInterval(securePromptPayPollTimer);
                securePromptPayPollTimer = setInterval(() => {
                    void securePollPromptPayStatus(user, result.invoiceNo);
                }, 3000);
                void securePollPromptPayStatus(user, result.invoiceNo);
                return true;
            } catch (error) {
                securePromptPayInvoice = null;
                if (status) status.innerText = 'PromptPay ยังไม่พร้อมใช้งาน';
                alert('PromptPay: ' + (error?.message || 'ไม่สามารถสร้างรายการชำระเงินได้'));
                return false;
            }
        }

        closePaymentModal = function() {
            if (securePromptPayPollTimer) clearInterval(securePromptPayPollTimer);
            securePromptPayPollTimer = null;
            securePromptPayInvoice = null;
            secureSetPromptPayModal(false);
            const status = document.getElementById('payment-status');
            if (status) status.innerText = 'พร้อมสร้างรายการชำระเงิน';
            if (secureBaseClosePaymentModal) return secureBaseClosePaymentModal();
            document.getElementById('payment-modal')?.classList.add('hidden');
        };

        openPaymentModal = function(type, _price, title) {
            if (!state.isLoggedIn || !auth.currentUser) {
                alert('กรุณาล็อกอินด้วย Google Account ก่อนทำรายการ');
                return;
            }

            if (type === 'vip1') {
                void secureStartPromptPayCheckout(title);
                return;
            }

            const cfg = SECURE_PAYMENT_ITEMS[type];
            if (!cfg) {
                alert('รายการสินค้าไม่ถูกต้อง');
                return;
            }

            const livePricing = typeof liveSiteConfig !== 'undefined' ? liveSiteConfig?.pricing : null;
            const livePrice = Number(livePricing?.[type]);
            const price = Number.isSafeInteger(livePrice) && livePrice > 0 ? livePrice : cfg.price;
            state.pendingPayment = { type, price, title: title || cfg.title };
            document.getElementById('pay-item-title').innerText = state.pendingPayment.title;
            document.getElementById('pay-item-price').innerText = price + ' บาท';
            secureSetPromptPayModal(false);
            const status = document.getElementById('payment-status');
            if (status) status.innerText = 'อัปโหลดสลิปหลังชำระเงิน';
            document.getElementById('promptpay-qr-img').src = `https://promptpay.io/${SECURE_PAYMENT_PROMPTPAY_TARGET}/${price}.png`;
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

                const appCheckToken = typeof secureGetAppCheckToken === 'function'
                    ? await secureGetAppCheckToken(false) : '';
                const response = await fetch(SECURE_WORKER_HTTP_BASE + '/verify-slip', {
                    method: 'POST',
                    headers: { 'Authorization': 'Bearer ' + token,
                        ...(appCheckToken ? { 'X-Firebase-AppCheck': appCheckToken } : {}) },
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
