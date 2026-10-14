        const WHEEL_ITEMS = catalog.WHEEL_ITEMS;

        let currentWheelAngle = 0;

        function drawLuckyWheel() {
            const canvas = document.getElementById('wheel-canvas');
            if (!canvas) return;
            const ctx = canvas.getContext('2d');
            const cx = canvas.width / 2;
            const cy = canvas.height / 2;
            const radius = canvas.width / 2 - 8;

            ctx.clearRect(0, 0, canvas.width, canvas.height);

            const totalSlices = WHEEL_ITEMS.length;
            const sliceAngle = (2 * Math.PI) / totalSlices;

            ctx.save();
            ctx.translate(cx, cy);
            ctx.rotate(currentWheelAngle);

            WHEEL_ITEMS.forEach((item, idx) => {
                const startA = idx * sliceAngle;
                const endA = startA + sliceAngle;

                ctx.beginPath();
                ctx.moveTo(0, 0);
                ctx.arc(0, 0, radius, startA, endA);
                ctx.closePath();
                ctx.fillStyle = item.color;
                ctx.fill();
                ctx.lineWidth = 2;
                ctx.strokeStyle = "#ffffff";
                ctx.stroke();

                ctx.save();
                ctx.rotate(startA + sliceAngle / 2);
                ctx.textAlign = "right";
                ctx.fillStyle = "#ffffff";
                ctx.font = "bold 15px Kanit";
                ctx.fillText(item.label, radius - 15, 5);
                ctx.restore();
            });

            ctx.beginPath();
            ctx.arc(0, 0, 20, 0, 2 * Math.PI);
            ctx.fillStyle = "#ffffff";
            ctx.fill();
            ctx.strokeStyle = "#f59e0b";
            ctx.lineWidth = 4;
            ctx.stroke();

            ctx.restore();
        }

        function triggerLuckyBoxModal() {
            state.isPaused = true;
            const localNameTag = document.getElementById('player-nametag');
            if (localNameTag) localNameTag.style.display = 'none';
            state.wheelSpinning = false;
            document.getElementById('wheel-modal').classList.remove('hidden');
            document.getElementById('btn-spin-wheel').classList.remove('hidden');
            document.getElementById('btn-close-wheel').classList.add('hidden');
            document.getElementById('wheel-result-msg').innerText = "กดปุ่มเพื่อเริ่มหมุนวงล้อ!";
            drawLuckyWheel();
            audio.playBoxHit();
        }

        function spinWheel() {
            if (state.wheelSpinning) return;
            state.wheelSpinning = true;

            document.getElementById('btn-spin-wheel').classList.add('hidden');
            document.getElementById('wheel-result-msg').innerText = "กำลังหมุนวงล้อ...";

            const rand = Math.random() * 100;
            let accum = 0;
            let selectedIdx = 0;

            for (let i = 0; i < WHEEL_ITEMS.length; i++) {
                accum += WHEEL_ITEMS[i].weight;
                if (rand < accum) {
                    selectedIdx = i;
                    break;
                }
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

            function animateSpin(now) {
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
                    addScore(state.wheelReward.value);
                    audio.playReward();

                    document.getElementById('wheel-result-msg').innerHTML = `
                        <span class="text-amber-400 font-extrabold text-xl animate-bounce">
                            ยินดีด้วย! คุณได้รับ +${state.wheelReward.value.toLocaleString()} เหรียญ!
                        </span>
                    `;
                    document.getElementById('btn-close-wheel').classList.remove('hidden');
                }
            }

            requestAnimationFrame(animateSpin);
        }

        function closeWheelModal() {
            document.getElementById('wheel-modal').classList.add('hidden');
            state.isPaused = false;
        }

        // 🏷️ แสดงชื่อเฉพาะตอนอยู่ในหน้าเล่นเกม และเฉพาะผู้เล่นที่อยู่ในระยะสายตา
        function updatePlayerNametagPosition() {
            const localTag = document.getElementById('player-nametag');

            // ป้องกันชื่อไปโผล่บนหน้าเมนู / modal / หน้าต่างอื่นของเกม
            const gameVisible = state.isPlaying && !state.isPaused && camera && renderer;

            if (!gameVisible) {
                if (localTag) localTag.style.display = 'none';
                Object.keys(otherPlayers).forEach(id => {
                    const op = otherPlayers[id];
                    if (op && op.nameTagEl) op.nameTagEl.style.display = 'none';
                });
                return;
            }

            const canvasRect = renderer.domElement.getBoundingClientRect();
            const maxDistance = 28; // ระยะที่สามารถเห็นชื่อผู้เล่นอื่น

            // Build one conservative shortlist lazily per frame, shared by all
            // visible labels. The sphere includes the camera and every eligible
            // head, so geometry outside it cannot intersect a label segment.
            let occludersReady = false;
            const origin = camera.getWorldPosition(new THREE.Vector3());
            function nearbyOccluders() {
                if (occludersReady) return nameplateOccluders;
                occludersReady = true;
                nameplateOccluders.length = 0;
                const reach = origin.distanceTo(playerPos) + maxDistance + 2.75;
                const bounds = new THREE.Sphere();
                staticMapObjects.forEach(object => {
                    if (!object || !object.visible || !object.geometry) return;
                    object.updateWorldMatrix(true, false);
                    if (!object.geometry.boundingSphere) object.geometry.computeBoundingSphere();
                    bounds.copy(object.geometry.boundingSphere).applyMatrix4(object.matrixWorld);
                    if (bounds.center.distanceTo(origin) <= reach + bounds.radius)
                        nameplateOccluders.push(object);
                });
                return nameplateOccluders;
            }

            function updateTag(tag, worldPos, extraDistanceCheck = null) {
                if (!tag) return;

                if (extraDistanceCheck !== null && extraDistanceCheck > maxDistance) {
                    tag.style.display = 'none';
                    return;
                }

                const projected = worldPos.clone().project(camera);

                // z >= 1 = อยู่หลังกล้อง
                // x/y นอกช่วง = อยู่นอกขอบจอ
                if (
                    projected.z >= 1 ||
                    projected.x < -1.05 || projected.x > 1.05 ||
                    projected.y < -1.05 || projected.y > 1.05
                ) {
                    tag.style.display = 'none';
                    return;
                }

                // DOM labels have no depth buffer: explicitly test opaque map
                // geometry between the camera and remote player's head.
                if (extraDistanceCheck !== null && typeof staticMapObjects !== 'undefined') {
                    const direction = worldPos.clone().sub(origin);
                    const length = direction.length();
                    if (length > 0) {
                        const ray = new THREE.Raycaster(origin, direction.normalize(), 0, Math.max(0, length - 0.01));
                        const blocked = nearbyOccluders().some(object => {
                            return ray.intersectObject(object, false).length > 0;
                        });
                        if (blocked) {
                            tag.style.display = 'none';
                            return;
                        }
                    }
                }

                const x = (projected.x * 0.5 + 0.5) * canvasRect.width + canvasRect.left;
                const y = (projected.y * -0.5 + 0.5) * canvasRect.height + canvasRect.top;

                tag.style.left = `${x}px`;
                tag.style.top = `${y}px`;
                tag.style.display = 'block';
            }

            // ชื่อของเรา: แสดงเฉพาะตอนอยู่ในหน้าเล่นเกม
            if (localTag) {
                updateTag(
                    localTag,
                    new THREE.Vector3(playerPos.x, playerPos.y + 2.75, playerPos.z)
                );
            }

            // ชื่อผู้เล่นอื่น: ต้องอยู่ในระยะใกล้ + อยู่ด้านหน้ากล้อง + อยู่ในจอ
            Object.keys(otherPlayers).forEach(id => {
                const op = otherPlayers[id];
                if (!op || !op.mesh || !op.nameTagEl) return;

                const distance = playerPos.distanceTo(op.mesh.position);

                updateTag(
                    op.nameTagEl,
                    new THREE.Vector3(
                        op.mesh.position.x,
                        op.mesh.position.y + 2.75,
                        op.mesh.position.z
                    ),
                    distance
                );
            });
        }

        const clock = new THREE.Clock();

        function gameLoop() {
            requestAnimationFrame(gameLoop);

            const delta = Math.min(clock.getDelta(), 0.1);
            const nowMs = Date.now();

            if (state.isPlaying && !state.isPaused) {
                securePredictMovement(delta);
                const currentSpeed = Math.sqrt(playerVel.x * playerVel.x + playerVel.z * playerVel.z);
                playerGroup.rotation.y = playerRotation;

                if (currentSpeed > 0.5) {
                    walkCycle += delta * 12;
                    const armAngle = Math.sin(walkCycle) * 0.6;
                    leftArm.rotation.x = armAngle;
                    rightArm.rotation.x = -armAngle;
                    leftLeg.rotation.x = -armAngle;
                    rightLeg.rotation.x = armAngle;
                } else {
                    const limbDamp = Math.min(1, 15 * delta);
                    leftArm.rotation.x += (0 - leftArm.rotation.x) * limbDamp;
                    rightArm.rotation.x += (0 - rightArm.rotation.x) * limbDamp;
                    leftLeg.rotation.x += (0 - leftLeg.rotation.x) * limbDamp;
                    rightLeg.rotation.x += (0 - rightLeg.rotation.x) * limbDamp;
                }

                const correctionDamp = Math.min(1, 12 * delta);
                securePredictionCorrection.x *= 1 - correctionDamp;
                securePredictionCorrection.y *= 1 - correctionDamp;
                securePredictionCorrection.z *= 1 - correctionDamp;
                playerGroup.position.set(
                    playerPos.x + securePredictionCorrection.x,
                    playerPos.y + securePredictionCorrection.y,
                    playerPos.z + securePredictionCorrection.z
                );

                // Send intent and an ordered sequence; position remains server-owned.
                syncMyPlayerData();

                const camDx = Math.sin(cameraYaw) * Math.cos(cameraPitch) * cameraDistance;
                const camDy = Math.sin(cameraPitch) * cameraDistance;
                const camDz = Math.cos(cameraYaw) * Math.cos(cameraPitch) * cameraDistance;

                const targetCamPos = new THREE.Vector3(
                    playerGroup.position.x + camDx,
                    playerGroup.position.y + camDy,
                    playerGroup.position.z + camDz
                );

                const rawLookAt = new THREE.Vector3(playerGroup.position.x, playerGroup.position.y + 1.5, playerGroup.position.z);
                const camDamp = Math.min(1, 12 * delta);

                camera.position.lerp(targetCamPos, camDamp);
                smoothCamTarget.lerp(rawLookAt, camDamp);
                camera.lookAt(smoothCamTarget);

                coins.forEach((coin) => {
                    // Project only the cooldown supplied by the authoritative
                    // room, using its clock offset rather than device time.
                    if (!coin.active && coin.respawnTime > 0 && secureNow() >= coin.respawnTime) {
                        coin.active = true;
                        coin.mesh.visible = true;
                        coin.respawnTime = 0;
                    }

                    if (coin.active) {
                        coin.mesh.rotation.z += delta * coin.rotSpeed;
                        coin.mesh.position.y = coin.baseY + Math.sin(nowMs * 0.005 + coin.mesh.position.x) * 0.3;

                        const distToPlayer = playerPos.distanceTo(coin.mesh.position);
                        if (distToPlayer < 2.2) {
                            collectCoin(coin, nowMs);
                        }
                    }
                });

                if (luckyBox) {
                    secureUpdateLuckyBoxTimer();

                    if (luckyBox.active && luckyBox.mesh) {
                        luckyBox.mesh.rotation.y += delta * 0.8;
                        luckyBox.mesh.position.y = luckyBox.baseY + Math.sin(nowMs * 0.004) * 0.18;

                        const distToBox = playerPos.distanceTo(luckyBox.mesh.position);
                        if (distToBox < 2.8) {
                            secureRequestLuckyBoxCollect();
                        }
                    }
                }

                // Update 3D Nametags position on screen smoothly
                updatePlayerNametagPosition();

                // Update remote players animation & movement
                Object.keys(otherPlayers).forEach(id => {
                    const op = otherPlayers[id];
                    if (op._secureLastSeenAt && performance.now() - op._secureLastSeenAt > 3500) {
                        removeOtherPlayer(id);
                        return;
                    }
                    op.mesh.position.lerp(op.targetPos, 0.15);

                    let diffRot = op.targetRot - op.mesh.rotation.y;
                    while (diffRot < -Math.PI) diffRot += Math.PI * 2;
                    while (diffRot > Math.PI) diffRot -= Math.PI * 2;
                    op.mesh.rotation.y += diffRot * 0.15;

                    const pDist = op.mesh.position.distanceTo(op.targetPos);
                    if (pDist > 0.1) {
                        op.walkCycle += delta * 12;
                        const armAngle = Math.sin(op.walkCycle) * 0.6;
                        op.leftArm.rotation.x = armAngle;
                        op.rightArm.rotation.x = -armAngle;
                        op.leftLeg.rotation.x = -armAngle;
                        op.rightLeg.rotation.x = armAngle;
                    } else {
                        op.leftArm.rotation.x = 0;
                        op.rightArm.rotation.x = 0;
                        op.leftLeg.rotation.x = 0;
                        op.rightLeg.rotation.x = 0;
                    }
                });
            }

            if (state.isPlaying && state.isPaused) syncMyPlayerData();
            renderer.render(scene, camera);
        }
