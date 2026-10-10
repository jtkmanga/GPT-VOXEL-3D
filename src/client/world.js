        // Three.js Scene Setup
        let scene, camera, renderer;
        let playerGroup, playerBody, leftArm, rightArm, leftLeg, rightLeg;
        const MAP_SIZE = config.SERVER_MAP_SIZE;
        const MAX_COINS_PER_MAP = config.SERVER_COIN_COUNT;
        const COIN_RESPAWN_MS = config.RESPAWN_MS;
        const LUCKY_BOX_RESPAWN_MS = config.LUCKY_BOX_RESPAWN_MS;

        const buildings = [];
        const trees = [];
        const coins = [];
        let luckyBox = null;

        // 🌐 SERVER MAP SYNC: ทุกคนในเซิร์ฟเวอร์เดียวกันใช้ seed เดียวกัน
        let serverMapSeed = 'default-map';
        let mapRandom = Math.random;
        const staticMapObjects = [];

        function createSeededRandom(seedText) {
            let seed = 2166136261;
            const str = String(seedText || 'default-map');

            for (let i = 0; i < str.length; i++) {
                seed ^= str.charCodeAt(i);
                seed = Math.imul(seed, 16777619);
            }

            return function() {
                seed += 0x6D2B79F5;
                let t = seed;
                t = Math.imul(t ^ (t >>> 15), t | 1);
                t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
                return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
            };
        }

        function clearStaticMapObjects() {
            staticMapObjects.forEach(obj => {
                if (obj && scene) scene.remove(obj);
            });
            staticMapObjects.length = 0;
            buildings.length = 0;
            trees.length = 0;
        }

        function rebuildServerStaticMap(serverId) {
            serverMapSeed = String(serverId || 'default-map');
            mapRandom = createSeededRandom(serverMapSeed);

            clearStaticMapObjects();

            // สร้างตึก + ต้นไม้ใหม่ด้วย seed ของเซิร์ฟเวอร์
            buildVoxelStructures();

            // สร้างเหรียญใหม่ด้วย seed เดียวกัน
            coins.forEach(c => {
                if (c && c.mesh && scene) scene.remove(c.mesh);
            });
            coins.length = 0;
            spawnCoins(MAX_COINS_PER_MAP);
        }

        const playerPos = new THREE.Vector3(0, 0, 0);
        const playerVel = new THREE.Vector3(0, 0, 0);
        const smoothCamTarget = new THREE.Vector3(0, 1.5, 0);
        let playerVelocityY = 0;
        let isGrounded = true;
        let playerRotation = 0;
        let walkCycle = 0;

        let cameraYaw = 0;
        let cameraPitch = 0.5;
        const cameraDistance = 18;

        const keys = { w: false, a: false, s: false, d: false };
        const joystickVec = { x: 0, y: 0 };

        function init3D() {
            const container = document.getElementById('game-canvas');

            scene = new THREE.Scene();
            scene.background = new THREE.Color(0x60a5fa);
            scene.fog = new THREE.FogExp2(0x93c5fd, 0.0007);

            camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 4000);

            renderer = new THREE.WebGLRenderer({ canvas: container, antialias: true });
            renderer.setSize(window.innerWidth, window.innerHeight);
            renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
            renderer.shadowMap.enabled = true;
            renderer.shadowMap.type = THREE.PCFSoftShadowMap;

            const ambientLight = new THREE.AmbientLight(0xffffff, 0.75);
            scene.add(ambientLight);

            const sunLight = new THREE.DirectionalLight(0xfffbeb, 1.1);
            sunLight.position.set(300, 450, -200);
            sunLight.castShadow = true;
            sunLight.shadow.mapSize.width = 2048;
            sunLight.shadow.mapSize.height = 2048;
            sunLight.shadow.camera.near = 0.5;
            sunLight.shadow.camera.far = 1200;
            const d = 500;
            sunLight.shadow.camera.left = -d;
            sunLight.shadow.camera.right = d;
            sunLight.shadow.camera.top = d;
            sunLight.shadow.camera.bottom = -d;
            scene.add(sunLight);

            buildVoxelTerrain();
            buildVoxelStructures();
            buildVoxelPlayer();
            setupControls();

            window.addEventListener('resize', onWindowResize);
        }

        function buildVoxelTerrain() {
            const groundGeo = new THREE.BoxGeometry(MAP_SIZE, 2, MAP_SIZE);
            const groundMat = new THREE.MeshLambertMaterial({ color: 0x48bb78 });
            const ground = new THREE.Mesh(groundGeo, groundMat);
            ground.position.y = -1;
            ground.receiveShadow = true;
            scene.add(ground);

            const detailGeo = new THREE.BoxGeometry(4, 0.1, 4);
            const detailMat = new THREE.MeshLambertMaterial({ color: 0x38a169 });
            for(let i = 0; i < 600; i++) {
                const rx = (mapRandom() - 0.5) * (MAP_SIZE - 20);
                const rz = (mapRandom() - 0.5) * (MAP_SIZE - 20);
                const patch = new THREE.Mesh(detailGeo, detailMat);
                patch.position.set(Math.floor(rx/4)*4, 0.05, Math.floor(rz/4)*4);
                patch.receiveShadow = true;
                scene.add(patch);
            }
        }

        function buildVoxelStructures() {
            const darkBuildingMat = new THREE.MeshLambertMaterial({ color: 0x2d3748 });
            const brownBuildingMat = new THREE.MeshLambertMaterial({ color: 0x742a2a });
            const blueBuildingMat = new THREE.MeshLambertMaterial({ color: 0x2b6cb0 });
            const windowMat = new THREE.MeshBasicMaterial({ color: 0xfbd38d });
            const trunkMat = new THREE.MeshLambertMaterial({ color: 0x5c3d2e });
            const leafMat = new THREE.MeshLambertMaterial({ color: 0x2f855a });

            const materials = [darkBuildingMat, brownBuildingMat, blueBuildingMat];

            for (let bx = -600; bx <= 600; bx += 200) {
                for (let bz = -600; bz <= 600; bz += 200) {
                    if (Math.abs(bx) < 100 && Math.abs(bz) < 100) continue;

                    const width = 18 + Math.floor(mapRandom() * 20);
                    const depth = 18 + Math.floor(mapRandom() * 20);
                    const height = 28 + Math.floor(mapRandom() * 65);
                    const mat = materials[Math.floor(mapRandom() * materials.length)];

                    const posX = bx + (mapRandom() - 0.5) * 60;
                    const posZ = bz + (mapRandom() - 0.5) * 60;

                    const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), mat);
                    mesh.position.set(posX, height / 2, posZ);
                    mesh.castShadow = true;
                    mesh.receiveShadow = true;
                    scene.add(mesh);
                    staticMapObjects.push(mesh);

                    for (let y = 6; y < height - 6; y += 8) {
                        for (let x = -width / 2 + 3; x < width / 2 - 2; x += 5) {
                            const win = new THREE.Mesh(new THREE.BoxGeometry(2, 3, 0.2), windowMat);
                            win.position.set(posX + x, y, posZ + depth / 2 + 0.1);
                            scene.add(win);
                            staticMapObjects.push(win);
                        }
                    }

                    buildings.push({
                        minX: posX - width / 2 - 2,
                        maxX: posX + width / 2 + 2,
                        minZ: posZ - depth / 2 - 2,
                        maxZ: posZ + depth / 2 + 2
                    });
                }
            }

            for (let i = 0; i < 250; i++) {
                const tx = (mapRandom() - 0.5) * (MAP_SIZE - 50);
                const tz = (mapRandom() - 0.5) * (MAP_SIZE - 50);

                let insideBuilding = buildings.some(b => tx >= b.minX && tx <= b.maxX && tz >= b.minZ && tz <= b.maxZ);
                if (insideBuilding || (Math.abs(tx) < 25 && Math.abs(tz) < 25)) continue;

                const trunkHeight = 6 + mapRandom() * 4;
                const trunk = new THREE.Mesh(new THREE.BoxGeometry(2, trunkHeight, 2), trunkMat);
                trunk.position.set(tx, trunkHeight / 2, tz);
                trunk.castShadow = true;
                scene.add(trunk);
                staticMapObjects.push(trunk);

                const leafSize = 6 + mapRandom() * 3;
                const leaves = new THREE.Mesh(new THREE.BoxGeometry(leafSize, leafSize, leafSize), leafMat);
                leaves.position.set(tx, trunkHeight + leafSize / 2 - 1, tz);
                leaves.castShadow = true;
                scene.add(leaves);
                staticMapObjects.push(leaves);

                trees.push({
                    minX: tx - 1.8,
                    maxX: tx + 1.8,
                    minZ: tz - 1.8,
                    maxZ: tz + 1.8
                });
            }
        }

        function buildVoxelPlayer() {
            playerGroup = new THREE.Group();

            const skinMat = new THREE.MeshLambertMaterial({ color: 0xffdbac });
            const shirtMat = new THREE.MeshLambertMaterial({ color: 0x3182ce });
            const pantsMat = new THREE.MeshLambertMaterial({ color: 0x2b6cb0 });

            const head = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.9, 0.9), skinMat);
            head.position.y = 1.85;
            head.castShadow = true;
            playerGroup.add(head);

            const eyeMat = new THREE.MeshBasicMaterial({ color: 0x1a202c });
            const leftEye = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.15, 0.05), eyeMat);
            leftEye.position.set(-0.2, 1.9, 0.46);
            playerGroup.add(leftEye);

            const rightEye = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.15, 0.05), eyeMat);
            rightEye.position.set(0.2, 1.9, 0.46);
            playerGroup.add(rightEye);

            playerBody = new THREE.Mesh(new THREE.BoxGeometry(1.0, 1.1, 0.6), shirtMat);
            playerBody.position.y = 1.05;
            playerBody.castShadow = true;
            playerGroup.add(playerBody);

            leftArm = new THREE.Mesh(new THREE.BoxGeometry(0.35, 1.0, 0.35), skinMat);
            leftArm.position.set(-0.7, 1.0, 0);
            leftArm.castShadow = true;
            playerGroup.add(leftArm);

            rightArm = new THREE.Mesh(new THREE.BoxGeometry(0.35, 1.0, 0.35), skinMat);
            rightArm.position.set(0.7, 1.0, 0);
            rightArm.castShadow = true;
            playerGroup.add(rightArm);

            leftLeg = new THREE.Mesh(new THREE.BoxGeometry(0.42, 1.0, 0.42), pantsMat);
            leftLeg.position.set(-0.25, 0.5, 0);
            leftLeg.castShadow = true;
            playerGroup.add(leftLeg);

            rightLeg = new THREE.Mesh(new THREE.BoxGeometry(0.42, 1.0, 0.42), pantsMat);
            rightLeg.position.set(0.25, 0.5, 0);
            rightLeg.castShadow = true;
            playerGroup.add(rightLeg);

            playerGroup.position.set(0, 0, 0);
            scene.add(playerGroup);
        }

        function initServerMapData(serverId) {
            // สำคัญ: map ทั้งหมดถูกสร้างจาก seed ของ serverId เดียวกัน
            rebuildServerStaticMap(serverId);

            if (luckyBox && luckyBox.mesh) {
                scene.remove(luckyBox.mesh);
                luckyBox = null;
            }

            listenToCoinsRealtime(serverId);
            spawnLuckyBoxes(serverId);
        }

        function spawnCoins(count) {
            const coinGeo = new THREE.CylinderGeometry(0.6, 0.6, 0.15, 8);
            const coinMat = new THREE.MeshStandardMaterial({
                color: 0xe2e8f0,
                metalness: 0.9,
                roughness: 0.2
            });

            for (let i = 0; i < count; i++) {
                let rx, rz, collision;
                do {
                    rx = (mapRandom() - 0.5) * (MAP_SIZE - 12);
                    rz = (mapRandom() - 0.5) * (MAP_SIZE - 12);
                    collision =
                        buildings.some(b => rx >= b.minX && rx <= b.maxX && rz >= b.minZ && rz <= b.maxZ) ||
                        trees.some(t => rx >= t.minX && rx <= t.maxX && rz >= t.minZ && rz <= t.maxZ);
                } while (collision);

                const coinMesh = new THREE.Mesh(coinGeo, coinMat);
                coinMesh.position.set(rx, 1.2, rz);
                coinMesh.rotation.x = Math.PI / 2;
                coinMesh.castShadow = true;
                scene.add(coinMesh);

                coins.push({
                    id: `coin_${i}`,
                    mesh: coinMesh,
                    active: true,
                    respawnTime: 0,
                    baseY: 1.2,
                    rotSpeed: 1 + mapRandom() * 2
                });
            }
        }

        let coinsServerRef = null;

        // สถานะเหรียญเป็นข้อมูลกลางของ server:
        // เมื่อผู้เล่นคนใดเก็บ เหรียญจุดนั้นจะหายจากทุกเครื่องและกลับมาใน 1 นาที
        function listenToCoinsRealtime(serverId) {
            if (coinsServerRef) coinsServerRef.off();

            coinsServerRef = database.ref(`servers/${serverId}/world/coins`);

            coinsServerRef.on('value', (snapshot) => {
                const data = snapshot.val() || {};
                const now = Date.now();

                coins.forEach((coin) => {
                    const respawnAt = Number(data[coin.id]?.respawnTimestamp || 0);

                    coin.respawnTime = respawnAt;

                    if (respawnAt > now) {
                        coin.active = false;
                        coin.mesh.visible = false;
                    } else {
                        coin.active = true;
                        coin.mesh.visible = true;
                    }
                });
            });
        }

        // เก็บเหรียญแบบ transaction เพื่อป้องกันผู้เล่น 2 คนเก็บเหรียญจุดเดียวกันพร้อมกัน
        function collectCoin(coin, nowMs) {
            if (!coin || !coin.active || !coinsServerRef) return;

            const coinRef = coinsServerRef.child(coin.id);

            coin.active = false;
            coin.mesh.visible = false;

            coinRef.transaction(current => {
                const currentRespawn = Number(current?.respawnTimestamp || 0);

                // มีผู้เล่นคนอื่นเก็บไปก่อนแล้ว -> ไม่ให้รางวัลซ้ำ
                if (currentRespawn > nowMs) return;

                return {
                    respawnTimestamp: nowMs + COIN_RESPAWN_MS,
                    updatedAt: firebase.database.ServerValue.TIMESTAMP
                };
            }).then(result => {
                if (!result.committed) return;

                // ได้สิทธิ์เก็บจริงเพียงคนเดียว
                let addCoinVal = 1;
                if (state.shop.coinBuffExpires > nowMs) addCoinVal = 2;

                addScore(addCoinVal);
                audio.playCoin();
            }).catch(err => {
                console.error("Coin collection sync error:", err);
            });
        }

        // จุดเกิดผู้เล่นเริ่มต้นของเกมอยู่ที่ (0, 0)
        // กล่องสมบัติจะไม่ถูกสุ่มในรัศมีนี้ เพื่อไม่ให้เข้าเกมแล้วกล่องอยู่ติดตัวผู้เล่น
        const LUCKY_BOX_MIN_DISTANCE_FROM_SPAWN = config.LUCKY_BOX_MIN_DISTANCE_FROM_SPAWN;

        function getDeterministicFreePosition(key, margin = 20, minDistanceFromSpawn = 0) {
            const rng = createSeededRandom(`${serverMapSeed}:position:${key}`);
            let rx = 0;
            let rz = 0;

            for (let attempt = 0; attempt < 2000; attempt++) {
                rx = (rng() - 0.5) * (MAP_SIZE - margin);
                rz = (rng() - 0.5) * (MAP_SIZE - margin);

                // ห้ามเกิดใกล้จุดเริ่มต้นผู้เล่น
                if (minDistanceFromSpawn > 0) {
                    const distFromSpawn = Math.sqrt(rx * rx + rz * rz);
                    if (distFromSpawn < minDistanceFromSpawn) continue;
                }

                const collision =
                    buildings.some(b => rx >= b.minX && rx <= b.maxX && rz >= b.minZ && rz <= b.maxZ) ||
                    trees.some(t => rx >= t.minX && rx <= t.maxX && rz >= t.minZ && rz <= t.maxZ);

                if (!collision) {
                    return { x: rx, z: rz };
                }
            }

            // fallback ที่ยังห่างจากจุดเกิดผู้เล่น
            return { x: minDistanceFromSpawn + 50, z: 0 };
        }

        function relocateLuckyBox(box, spawnCycle = 0) {
            // กล่องมีเพียง 1 กล่องต่อ server และตำแหน่งจะสุ่มใหม่ทุก spawnCycle
            // ใช้ seed เดียวกัน ทำให้ผู้เล่นทุกคนใน server เห็นตำแหน่งเดียวกัน
            // และเว้นระยะจากจุดเกิดกลางแมพ ไม่ให้เข้าเกมแล้วกล่องอยู่ตรงตัวผู้เล่น
            const pos = getDeterministicFreePosition(
                `lucky-box-${spawnCycle}`,
                20,
                LUCKY_BOX_MIN_DISTANCE_FROM_SPAWN
            );

            if (box && box.mesh) {
                box.mesh.position.set(pos.x, 0, pos.z);
            }
        }

        let luckyBoxServerRef = null;

        function createTreasureChest() {
            const chest = new THREE.Group();

            const woodMat = new THREE.MeshStandardMaterial({
                color: 0x8b4513,
                roughness: 0.65,
                metalness: 0.05
            });
            const darkWoodMat = new THREE.MeshStandardMaterial({
                color: 0x5a2d0c,
                roughness: 0.75
            });
            const goldMat = new THREE.MeshStandardMaterial({
                color: 0xfbbf24,
                emissive: 0x8a5a00,
                emissiveIntensity: 0.25,
                metalness: 0.85,
                roughness: 0.2
            });

            // ตัวหีบทรงสี่เหลี่ยม
            const base = new THREE.Mesh(new THREE.BoxGeometry(2.1, 1.25, 1.35), woodMat);
            base.position.y = 0.75;
            base.castShadow = true;
            base.receiveShadow = true;
            chest.add(base);

            // ฝาหีบโค้งแบบง่ายด้วยกล่องหลายชิ้น
            const lid = new THREE.Mesh(new THREE.BoxGeometry(2.15, 0.35, 1.4), darkWoodMat);
            lid.position.y = 1.55;
            lid.castShadow = true;
            chest.add(lid);

            const lidTop = new THREE.Mesh(new THREE.BoxGeometry(1.75, 0.28, 1.15), woodMat);
            lidTop.position.y = 1.82;
            lidTop.castShadow = true;
            chest.add(lidTop);

            // แถบทองคาดหีบ
            [-0.72, 0.72].forEach(x => {
                const band = new THREE.Mesh(new THREE.BoxGeometry(0.14, 1.65, 1.43), goldMat);
                band.position.set(x, 1.05, 0);
                band.castShadow = true;
                chest.add(band);
            });

            // แถบทองด้านหน้า
            const frontBand = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.95, 0.08), goldMat);
            frontBand.position.set(0, 0.82, 0.72);
            frontBand.castShadow = true;
            chest.add(frontBand);

            // แม่กุญแจ
            const lockBody = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.48, 0.12), goldMat);
            lockBody.position.set(0, 1.08, 0.76);
            lockBody.castShadow = true;
            chest.add(lockBody);

            const lockRing = new THREE.Mesh(
                new THREE.TorusGeometry(0.15, 0.045, 8, 16, Math.PI),
                goldMat
            );
            lockRing.position.set(0, 1.36, 0.77);
            lockRing.rotation.x = Math.PI / 2;
            lockRing.castShadow = true;
            chest.add(lockRing);

            return chest;
        }

        function spawnLuckyBoxes(serverId) {
            const chestMesh = createTreasureChest();
            scene.add(chestMesh);

            luckyBox = {
                mesh: chestMesh,
                active: true,
                baseY: 0,
                nextSpawnTimestamp: 0,
                spawnCycle: 0,
                collecting: false
            };

            if (luckyBoxServerRef) luckyBoxServerRef.off();
            luckyBoxServerRef = database.ref(`servers/${serverId}/world/luckyBox`);

            luckyBoxServerRef.on('value', (snapshot) => {
                const data = snapshot.val() || {};
                const nextSpawn = Number(data.nextSpawnTimestamp || 0);
                const spawnCycle = Number(data.spawnCycle || 0);
                const now = Date.now();

                luckyBox.nextSpawnTimestamp = nextSpawn;
                luckyBox.spawnCycle = spawnCycle;

                if (nextSpawn > now) {
                    luckyBox.active = false;
                    luckyBox.mesh.visible = false;
                } else {
                    luckyBox.active = true;
                    luckyBox.mesh.visible = true;
                    relocateLuckyBox(luckyBox, spawnCycle);
                }
            });

            luckyBoxServerRef.once('value').then(snapshot => {
                if (!snapshot.exists()) {
                    luckyBoxServerRef.set({
                        nextSpawnTimestamp: 0,
                        spawnCycle: 0,
                        updatedAt: firebase.database.ServerValue.TIMESTAMP
                    });
                }
            });
        }
