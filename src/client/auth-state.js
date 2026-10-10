
        // --- FIREBASE REAL GOOGLE AUTHENTICATION & DATABASE CONFIGURATION ---
        const firebaseConfig = {
            apiKey: "AIzaSyCwn4rJ48I_bsVI2Ez59szQJubShvhO1SE",
            authDomain: "lucky-game-6936b.firebaseapp.com",
            databaseURL: "https://lucky-game-6936b-default-rtdb.asia-southeast1.firebasedatabase.app",
            projectId: "lucky-game-6936b",
            storageBucket: "lucky-game-6936b.firebasestorage.app",
            messagingSenderId: "541211602508",
            appId: "1:541211602508:web:b41b55fb5462269fbc4ee9",
            measurementId: "G-YMC92E7BS7"
        };

        // Initialize Firebase
        firebase.initializeApp(firebaseConfig);
        const auth = firebase.auth();
        const database = firebase.database();
        const googleProvider = new firebase.auth.GoogleAuthProvider();

        let localGuestId = null;
        function getMyPlayerId() {
            if (state.userId) return state.userId;
            if (!localGuestId) {
                localGuestId = 'guest_' + Math.random().toString(36).substring(2, 9);
            }
            return localGuestId;
        }

        // 🆔 ระบบดึง Key คะแนนตาม userId แยกแต่ละบัญชีทันที (voxel_score_${currentId})
        function getScoreStorageKey() {
            const currentId = getMyPlayerId();
            return `voxel_score_${currentId}`;
        }

        function loadScoreForCurrentId() {
            const key = getScoreStorageKey();
            state.score = parseInt(localStorage.getItem(key)) || 0;
            updateScoreDisplay();
        }

        // Listen to Auth State Changes
        auth.onAuthStateChanged((user) => {
            if (user) {
                state.isLoggedIn = true;
                state.userId = user.uid;
                state.userEmail = user.email || "";
                state.userAvatar = user.photoURL || `https://ui-avatars.com/api/?name=${encodeURIComponent(user.displayName || 'Player')}&background=f59e0b&color=fff`;
                state.playerName = user.displayName ? user.displayName.split(' ')[0] : "Player" + Math.floor(100 + Math.random() * 900);

                document.getElementById('user-display-name').innerText = user.displayName || "Google User";
                document.getElementById('user-email').innerText = state.userEmail;
                document.getElementById('user-avatar').src = state.userAvatar;
                document.getElementById('input-username').value = state.playerName;

                document.getElementById('btn-google-login').classList.add('hidden');
                document.getElementById('user-profile-card').classList.remove('hidden');

                // Sync user VIP data & Load score for this account
                listenToUserVipStatus(user.uid);
                loadScoreForCurrentId();
            } else {
                state.isLoggedIn = false;
                state.userId = null;
                state.userVipSubscriptions = {};
                document.getElementById('btn-google-login').classList.remove('hidden');
                document.getElementById('user-profile-card').classList.add('hidden');
                renderServersUI();
                loadScoreForCurrentId();
            }
        });

        // Global Game State
        const state = {
            playerName: "Player1",
            userId: null,
            score: 0,
            isLoggedIn: false,
            userEmail: "",
            userAvatar: "",
            audioMuted: false,
            isPlaying: false,
            isPaused: false,
            wheelSpinning: false,
            wheelReward: null,
            // 🌐 SERVER STATE
            selectedServerId: null,
            userVipSubscriptions: {},
            vipServers: {
                vip1: { count: 0, max: config.VIP_ENTITLEMENT_CAP }
            },
            shop: {
                speedBuffExpires: 0,
                coinBuffExpires: 0
            },
            // PAYMENT STATE
            pendingPayment: {
                type: null,
                price: 0,
                title: ''
            }
        };

        // ฟังก์ชันบวกคะแนนและบันทึกลงหน่วยความจำ (localStorage) แยกตาม userId ของบัญชีนั้น ๆ
        function addScore(points) {
            state.score += points;
            const key = getScoreStorageKey();
            localStorage.setItem(key, state.score);
            updateScoreDisplay();
            syncMyPlayerData(true);
        }

        // ฟังก์ชันสำหรับรีเซ็ตคะแนนใหม่
        function resetHighScore() {
            state.score = 0;
            const key = getScoreStorageKey();
            localStorage.setItem(key, 0);
            updateScoreDisplay();
            syncMyPlayerData(true);
        }

        // Real Google Login Trigger
        function loginWithGoogle() {
            auth.signInWithPopup(googleProvider)
                .catch((err) => {
                    console.error("Google Authentication Error:", err);
                    alert("เข้าสู่ระบบด้วย Google ไม่สำเร็จ: " + err.message);
                });
        }

        function logoutGoogle() {
            auth.signOut().catch((err) => console.error("Sign Out Error:", err));
        }

        // 🌐 REALTIME SERVER SYSTEM LOGIC
        function listenToVipServersRealtime() {
            database.ref('vip_servers').on('value', (snapshot) => {
                const data = snapshot.val() || {};
                const now = Date.now();
                ['vip1'].forEach(sId => {
                    const serverData = data[sId] || {};
                    const members = serverData.members || {};
                    let activeCount = 0;

                    Object.keys(members).forEach(mId => {
                        const mData = members[mId];
                        let exp = 0;
                        if (typeof mData === 'object' && mData.expireTime) exp = mData.expireTime;
                        else if (typeof mData === 'number') exp = mData;
                        else if (mData === true) exp = Infinity;

                        if (!exp || now <= exp) {
                            activeCount++;
                        }
                    });

                    state.vipServers[sId].count = activeCount;
                });
                renderServersUI();
            });
        }

        function listenToUserVipStatus(uid) {
            database.ref('users/' + uid + '/vip_subscriptions').on('value', (snapshot) => {
                state.userVipSubscriptions = snapshot.val() || {};
                renderServersUI();
            });
        }

        function selectFreeServer(serverId) {
            state.selectedServerId = serverId;
            renderServersUI();
        }

        // เปิด Modal ชำระเงินด้วย PromptPay
        function openPaymentModal(type, price, title) {
            if (!state.isLoggedIn) {
                alert("กรุณาล็อกอินด้วย Google Account ก่อนทำการซื้อไอเทมหรือเซิร์ฟเวอร์ VIP!");
                return;
            }

            state.pendingPayment = { type, price, title };
            document.getElementById('pay-item-title').innerText = title;
            document.getElementById('pay-item-price').innerText = price + " บาท";

            const promptpayTarget = "0999999999";
            document.getElementById('promptpay-qr-img').src = `https://promptpay.io/${promptpayTarget}/${price}.png`;

            document.getElementById('slip-file-input').value = "";
            document.getElementById('payment-modal').classList.remove('hidden');
        }

        function closePaymentModal() {
            document.getElementById('payment-modal').classList.add('hidden');
        }

        // Legacy client-side Slip2Go verification and client-side entitlement grant
        // were removed. The secure Worker overrides below own both operations.
        async function verifyAndBuySlip() {
            throw new Error('Secure Worker payment handler not initialized yet');
        }

        function grantPurchasedItem() {
            return false;
        }

        function selectVipServer(serverId) {
            const vipSub = state.userVipSubscriptions[serverId];
            const now = Date.now();
            let isVipActive = false;
            let expireTime = 0;

            if (vipSub) {
                if (typeof vipSub === 'object' && vipSub.expireTime) expireTime = vipSub.expireTime;
                else if (typeof vipSub === 'number') expireTime = vipSub;
                else if (vipSub === true) expireTime = Infinity;

                if (expireTime === Infinity || now <= expireTime) {
                    isVipActive = true;
                }
            }

            if (!isVipActive) {
                alert("สิทธิ์ VIP เซิร์ฟเวอร์นี้หมดอายุแล้ว! กรุณาต่ออายุก่อนเข้าเล่น");
                return;
            }
            state.selectedServerId = serverId;
            renderServersUI();
        }

        function renderServersUI() {
            const isSelectedFree1 = state.selectedServerId === 'free1';
            const cardFree1 = document.getElementById('card-free1');
            const actionFree1 = document.getElementById('action-free1');

            if (cardFree1) {
                cardFree1.className = isSelectedFree1
                    ? "bg-blue-500/20 border-2 border-blue-400 rounded-xl p-2.5 flex items-center justify-between transition shadow-md shadow-blue-500/10"
                    : "bg-slate-800/80 border border-slate-700 rounded-xl p-2.5 flex items-center justify-between transition";
            }

            if (actionFree1) {
                actionFree1.innerHTML = `
                    <button onclick="selectFreeServer('free1')" class="${isSelectedFree1 ? 'bg-blue-500 text-slate-950 font-extrabold text-[11px] px-3 py-1 rounded-lg' : 'bg-slate-700 hover:bg-slate-600 text-blue-400 font-bold text-[11px] px-2.5 py-1 rounded-lg border border-blue-500/30 transition active:scale-95'}">
                        ${isSelectedFree1 ? 'กำลังเลือก' : 'เลือกเซิร์ฟ'}
                    </button>
                `;
            }

            ['vip1'].forEach(sId => {
                const count = state.vipServers[sId].count;
                const max = state.vipServers[sId].max;
                const vipSub = state.userVipSubscriptions[sId];
                const now = Date.now();

                let isVipActive = false;
                let expireTime = 0;
                if (vipSub) {
                    if (typeof vipSub === 'object' && vipSub.expireTime) expireTime = vipSub.expireTime;
                    else if (typeof vipSub === 'number') expireTime = vipSub;
                    else if (vipSub === true) expireTime = Infinity;

                    if (expireTime === Infinity || now <= expireTime) {
                        isVipActive = true;
                    }
                }

                const isSelected = state.selectedServerId === sId;

                const cardEl = document.getElementById(`card-${sId}`);
                const countEl = document.getElementById(`count-${sId}`);
                const badgeOwnedEl = document.getElementById(`badge-owned-${sId}`);
                const actionContainer = document.getElementById(`action-${sId}`);

                if (countEl) countEl.innerText = `${count}/${max}`;

                if (badgeOwnedEl) {
                    if (isVipActive) {
                        badgeOwnedEl.classList.remove('hidden');
                        if (expireTime !== Infinity) {
                            const remainingMs = expireTime - now;
                            const days = Math.floor(remainingMs / (1000 * 60 * 60 * 24));
                            const hours = Math.floor((remainingMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
                            badgeOwnedEl.innerText = `เหลือ ${days}วัน ${hours}ชม.`;
                            badgeOwnedEl.className = "text-[9px] bg-emerald-500/20 text-emerald-400 border border-emerald-500/40 px-1.5 py-0.2 rounded font-bold";
                        } else {
                            badgeOwnedEl.innerText = `มีสิทธิ์ (ถาวร)`;
                        }
                    } else {
                        badgeOwnedEl.classList.add('hidden');
                    }
                }

                if (cardEl) {
                    cardEl.className = isSelected
                        ? "bg-amber-500/20 border-2 border-amber-400 rounded-xl p-2.5 flex items-center justify-between transition shadow-md shadow-amber-500/10"
                        : "bg-slate-800/80 border border-slate-700 rounded-xl p-2.5 flex items-center justify-between transition";
                }

                if (actionContainer) {
                    actionContainer.innerHTML = '';

                    if (isVipActive) {
                        const btnSelect = document.createElement('button');
                        btnSelect.className = isSelected
                            ? "bg-amber-500 text-slate-950 font-extrabold text-[11px] px-3 py-1 rounded-lg"
                            : "bg-slate-700 hover:bg-slate-600 text-amber-400 font-bold text-[11px] px-2.5 py-1 rounded-lg border border-amber-500/30 transition active:scale-95";
                        btnSelect.innerText = isSelected ? "กำลังเลือก" : "เลือกเซิร์ฟ";
                        btnSelect.onclick = () => selectVipServer(sId);
                        actionContainer.appendChild(btnSelect);

                        const btnRenew = document.createElement('button');
                        btnRenew.className = "bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 text-white font-bold text-[11px] px-2 py-1 rounded-lg shadow transition active:scale-95 ml-1";
                        btnRenew.innerText = "ต่ออายุ (+30วัน)";
                        btnRenew.onclick = () => openPaymentModal(sId, 50, 'ต่ออายุสิทธิ์ VIP Server 1 (30 วัน)');
                        actionContainer.appendChild(btnRenew);
                    } else {
                        const btnBuy = document.createElement('button');
                        if (count >= max) {
                            btnBuy.className = "bg-slate-700 text-slate-400 font-bold text-[11px] px-3 py-1 rounded-lg cursor-not-allowed";
                            btnBuy.innerText = "เต็มแล้ว";
                            btnBuy.disabled = true;
                        } else {
                            btnBuy.className = "bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-400 hover:to-amber-500 text-white font-bold text-[11px] px-3 py-1 rounded-lg shadow transition active:scale-95";
                            btnBuy.innerText = "ซื้อ VIP (50฿)";
                            btnBuy.onclick = () => openPaymentModal(sId, 50, 'สิทธิ์ VIP Server 1 (30 วัน)');
                        }
                        actionContainer.appendChild(btnBuy);
                    }
                }
            });

            const badgeHeader = document.getElementById('selected-server-badge');
            if (badgeHeader) {
                if (state.selectedServerId) {
                    badgeHeader.innerText = `เข้าเล่น: ${state.selectedServerId.toUpperCase()}`;
                    badgeHeader.className = "text-[10px] font-extrabold bg-amber-400 text-slate-900 px-2 py-0.5 rounded-full shadow";
                } else {
                    badgeHeader.innerText = "ยังไม่ได้เลือกเซิร์ฟเวอร์";
                    badgeHeader.className = "text-[10px] font-bold bg-amber-500/20 text-amber-300 px-2 py-0.5 rounded-full border border-amber-500/30";
                }
            }
        }
