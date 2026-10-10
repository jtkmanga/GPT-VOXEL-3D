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
                let moveX = 0;
                let moveZ = 0;

                if (keys.w) moveZ -= 1;
                if (keys.s) moveZ += 1;
                if (keys.a) moveX -= 1;
                if (keys.d) moveX += 1;

                if (Math.abs(joystickVec.x) > 0.05) moveX = joystickVec.x;
                if (Math.abs(joystickVec.y) > 0.05) moveZ = joystickVec.y;

                const inputLen = Math.sqrt(moveX * moveX + moveZ * moveZ);

                let moveSpeed = 22.0;
                if (state.shop.speedBuffExpires > nowMs) {
                    moveSpeed *= 2;
                }

                let targetVelX = 0;
                let targetVelZ = 0;

                if (inputLen > 0.05) {
                    const normX = moveX / Math.max(1, inputLen);
                    const normZ = moveZ / Math.max(1, inputLen);

                    const forwardAmount = -normZ;
                    const rightAmount = normX;

                    const worldMoveX = rightAmount * Math.cos(cameraYaw) - forwardAmount * Math.sin(cameraYaw);
                    const worldMoveZ = -rightAmount * Math.sin(cameraYaw) - forwardAmount * Math.cos(cameraYaw);
                    const inputMag = Math.min(inputLen, 1);

                    targetVelX = worldMoveX * moveSpeed * inputMag;
                    targetVelZ = worldMoveZ * moveSpeed * inputMag;
                }

                const accelDamp = Math.min(1, (isGrounded ? 18 : 10) * delta);
                playerVel.x += (targetVelX - playerVel.x) * accelDamp;
                playerVel.z += (targetVelZ - playerVel.z) * accelDamp;

                const nextX = playerPos.x + playerVel.x * delta;
                const nextZ = playerPos.z + playerVel.z * delta;

                const limit = MAP_SIZE / 2 - 2;
                const isObstacle = (x, z) => {
                    return buildings.some(b => x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ) ||
                           trees.some(t => x >= t.minX && x <= t.maxX && z >= t.minZ && z <= t.maxZ);
                };

                let collideX = isObstacle(nextX, playerPos.z);
                let collideZ = isObstacle(playerPos.x, nextZ);

                if (!collideX && Math.abs(nextX) < limit) playerPos.x = nextX; else playerVel.x = 0;
                if (!collideZ && Math.abs(nextZ) < limit) playerPos.z = nextZ; else playerVel.z = 0;

                const currentSpeed = Math.sqrt(playerVel.x * playerVel.x + playerVel.z * playerVel.z);

                if (currentSpeed > 0.5) {
                    const targetRotation = Math.atan2(playerVel.x, playerVel.z);
                    let diff = targetRotation - playerRotation;
                    while (diff < -Math.PI) diff += Math.PI * 2;
                    while (diff > Math.PI) diff -= Math.PI * 2;
                    playerRotation += diff * Math.min(1, 18 * delta);
                    playerGroup.rotation.y = playerRotation;
                }

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

                if (!isGrounded) {
                    playerPos.y += playerVelocityY * delta;
                    playerVelocityY -= 42.0 * delta;

                    if (playerPos.y <= 0) {
                        playerPos.y = 0;
                        playerVelocityY = 0;
                        isGrounded = true;
                    }
                }

                playerGroup.position.copy(playerPos);

                // Broadcast local position & score to multiplayer server
                syncMyPlayerData();

                const camDx = Math.sin(cameraYaw) * Math.cos(cameraPitch) * cameraDistance;
                const camDy = Math.sin(cameraPitch) * cameraDistance;
                const camDz = Math.cos(cameraYaw) * Math.cos(cameraPitch) * cameraDistance;

                const targetCamPos = new THREE.Vector3(
                    playerPos.x + camDx,
                    playerPos.y + camDy,
                    playerPos.z + camDz
                );

                const rawLookAt = new THREE.Vector3(playerPos.x, playerPos.y + 1.5, playerPos.z);
                const camDamp = Math.min(1, 12 * delta);

                camera.position.lerp(targetCamPos, camDamp);
                smoothCamTarget.lerp(rawLookAt, camDamp);
                camera.lookAt(smoothCamTarget);

                coins.forEach((coin) => {
                    // Firebase เป็นตัวกลางของสถานะ แต่การกลับมาแสดงผลหลัง 1 นาที
                    // ต้องทำได้ทันทีในเครื่องนี้โดยไม่ต้องรอ snapshot ใหม่
                    if (!coin.active && coin.respawnTime > 0 && nowMs >= coin.respawnTime) {
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

            renderer.render(scene, camera);
        }
