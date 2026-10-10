        // SHOP LOGIC FUNCTIONS
        function loadSavedBuffs() {
            const savedSpeed = localStorage.getItem('voxel_shop_speed_expire');
            const savedCoin = localStorage.getItem('voxel_shop_coin_expire');
            const now = Date.now();

            if (savedSpeed && parseInt(savedSpeed) > now) {
                state.shop.speedBuffExpires = parseInt(savedSpeed);
            }
            if (savedCoin && parseInt(savedCoin) > now) {
                state.shop.coinBuffExpires = parseInt(savedCoin);
            }
        }

        function openShopModal() {
            state.isPaused = true;
            const localNameTag = document.getElementById('player-nametag');
            if (localNameTag) localNameTag.style.display = 'none';
            updateShopUI();
            document.getElementById('shop-modal').classList.remove('hidden');
        }

        function closeShopModal() {
            document.getElementById('shop-modal').classList.add('hidden');
            state.isPaused = false;
        }

        function updateShopUI() {
            const now = Date.now();
            const btnSpeed = document.getElementById('btn-buy-speed');
            const btnCoin = document.getElementById('btn-buy-coin');

            const formatTime = (ms) => {
                const totalSec = Math.floor(ms / 1000);
                const h = Math.floor(totalSec / 3600);
                const m = Math.floor((totalSec % 3600) / 60);
                const s = totalSec % 60;
                return `${h}h ${m}m ${s}s`;
            };

            if (state.shop.speedBuffExpires > now) {
                btnSpeed.disabled = true;
                btnSpeed.className = "bg-slate-700 text-amber-400 border border-amber-500/30 font-bold py-1.5 px-3 rounded-lg text-xs flex-shrink-0 cursor-not-allowed";
                btnSpeed.innerText = `ใช้งานได้อีก ${formatTime(state.shop.speedBuffExpires - now)}`;
            } else {
                btnSpeed.disabled = false;
                btnSpeed.className = "bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-400 hover:to-amber-500 text-white font-bold py-1.5 px-3 rounded-lg text-xs shadow transition active:scale-95 flex-shrink-0";
                btnSpeed.innerText = "10 ฿";
            }

            if (state.shop.coinBuffExpires > now) {
                btnCoin.disabled = true;
                btnCoin.className = "bg-slate-700 text-emerald-400 border border-emerald-500/30 font-bold py-1.5 px-3 rounded-lg text-xs flex-shrink-0 cursor-not-allowed";
                btnCoin.innerText = `ใช้งานได้อีก ${formatTime(state.shop.coinBuffExpires - now)}`;
            } else {
                btnCoin.disabled = false;
                btnCoin.className = "bg-gradient-to-r from-emerald-500 to-emerald-600 hover:from-emerald-400 hover:to-emerald-500 text-white font-bold py-1.5 px-3 rounded-lg text-xs shadow transition active:scale-95 flex-shrink-0";
                btnCoin.innerText = "20 ฿";
            }
        }

        function startGame() {
            if (!state.selectedServerId) {
                alert("กรุณาเลือกเซิร์ฟเวอร์ (Free หรือ VIP) ก่อนเริ่มเล่นเกมครับ!");
                return;
            }

            const inputName = document.getElementById('input-username').value.trim();
            if (inputName) state.playerName = inputName;

            if (screen.orientation && screen.orientation.lock) {
                screen.orientation.lock('landscape').catch(() => {});
            }

            document.getElementById('start-screen').classList.add('hidden');
            document.getElementById('game-hud').classList.remove('hidden');
            document.getElementById('player-nametag').classList.remove('hidden');
            document.getElementById('nametag-text').innerText = state.playerName;
            document.getElementById('player-nametag').style.display = 'none';

            initServerMapData(state.selectedServerId);
            listenToRealtimeLeaderboard(state.selectedServerId);

            audio.playStart();
            state.isPlaying = true;
            // AOI starts from the player's current position; Zone is invisible to players.
            listenToRemotePlayers(state.selectedServerId, true);
            state.isPaused = false;

            // โหลดคะแนนเฉพาะไอดีปัจจุบันทันทีเมื่อเริ่มเล่น
            loadScoreForCurrentId();
            syncMyPlayerData(true);
        }

        function updateScoreDisplay() {
            document.getElementById('hud-score').innerText = state.score.toLocaleString();
        }

        function toggleAudio() {
            state.audioMuted = !state.audioMuted;
            audio.muted = state.audioMuted;
            const icon = document.getElementById('audio-icon');
            if (state.audioMuted) {
                icon.className = 'fa-solid fa-volume-xmark text-xl text-rose-400';
            } else {
                icon.className = 'fa-solid fa-volume-high text-xl text-amber-400';
            }
        }

        function openHomeConfirmModal() {
            state.isPaused = true;
            const localNameTag = document.getElementById('player-nametag');
            if (localNameTag) localNameTag.style.display = 'none';
            document.getElementById('exit-modal').classList.remove('hidden');
        }

        function closeHomeConfirmModal() {
            document.getElementById('exit-modal').classList.add('hidden');
            state.isPaused = false;
        }

        function confirmExitGame() {
            const myId = getMyPlayerId();

            // Remove the player from the AOI Zone database path.
            if (state.selectedServerId && myId) {
                const zoneId = currentPlayerZoneId || getPlayerZoneId(playerPos.x, playerPos.z);
                const myZoneRef = database.ref(
                    `servers/${state.selectedServerId}/zones/${zoneId}/players/${myId}`
                );
                myZoneRef.onDisconnect().cancel();
                myZoneRef.remove().catch(err => console.warn("AOI exit cleanup:", err));
            }

            // Stop all nearby-Zone listeners and clear remote player objects.
            removeAllAOIListeners();

            if (luckyBoxServerRef) luckyBoxServerRef.off();

            document.getElementById('exit-modal').classList.add('hidden');
            document.getElementById('game-hud').classList.add('hidden');
            document.getElementById('player-nametag').classList.add('hidden');
            document.getElementById('start-screen').classList.remove('hidden');
            state.isPlaying = false;
            state.isPaused = false;
        }

        function openFullLeaderboard() {
            document.getElementById('leaderboard-modal').classList.remove('hidden');
        }

        function closeFullLeaderboard() {
            document.getElementById('leaderboard-modal').classList.add('hidden');
        }
