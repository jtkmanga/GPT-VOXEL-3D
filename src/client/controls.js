        function setupControls() {
            window.addEventListener('keydown', (e) => {
                const code = e.code;
                const k = e.key ? e.key.toLowerCase() : '';
                if (code === 'KeyW' || code === 'ArrowUp' || k === 'w') keys.w = true;
                if (code === 'KeyS' || code === 'ArrowDown' || k === 's') keys.s = true;
                if (code === 'KeyA' || code === 'ArrowLeft' || k === 'a') keys.a = true;
                if (code === 'KeyD' || code === 'ArrowRight' || k === 'd') keys.d = true;
                if (code === 'Space' || e.keyCode === 32) {
                    e.preventDefault();
                    triggerJump();
                }
            });

            window.addEventListener('keyup', (e) => {
                const code = e.code;
                const k = e.key ? e.key.toLowerCase() : '';
                if (code === 'KeyW' || code === 'ArrowUp' || k === 'w') keys.w = false;
                if (code === 'KeyS' || code === 'ArrowDown' || k === 's') keys.s = false;
                if (code === 'KeyA' || code === 'ArrowLeft' || k === 'a') keys.a = false;
                if (code === 'KeyD' || code === 'ArrowRight' || k === 'd') keys.d = false;
            });

            const jumpBtn = document.getElementById('btn-jump');
            const handleJump = (e) => {
                if (e.cancelable) e.preventDefault();
                e.stopPropagation();
                triggerJump();
            };
            jumpBtn.addEventListener('touchstart', handleJump, { passive: false });
            jumpBtn.addEventListener('mousedown', handleJump);

            const joystickZone = document.getElementById('joystick-zone');
            const joystickHandle = document.getElementById('joystick-handle');
            let joystickActive = false;
            let joyTouchId = null;
            let joyCenter = { x: 0, y: 0 };

            function handleJoyStart(e) {
                if (joystickActive) return;
                const touch = e.changedTouches ? e.changedTouches[0] : e;
                if (!touch) return;
                joyTouchId = touch.identifier !== undefined ? touch.identifier : 'mouse';
                joystickActive = true;
                const rect = joystickZone.getBoundingClientRect();
                joyCenter = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
                handleJoyMove(e);
            }

            function handleJoyMove(e) {
                if (!joystickActive) return;
                let touch = e;
                if (e.changedTouches) {
                    let found = false;
                    for (let t of e.changedTouches) {
                        if (t.identifier === joyTouchId) { touch = t; found = true; break; }
                    }
                    if (!found) return;
                }
                const dx = touch.clientX - joyCenter.x;
                const dy = touch.clientY - joyCenter.y;
                const dist = Math.sqrt(dx * dx + dy * dy);
                const maxRadius = 45;

                const angle = Math.atan2(dy, dx);
                const clampedDist = Math.min(dist, maxRadius);

                const handleX = Math.cos(angle) * clampedDist;
                const handleY = Math.sin(angle) * clampedDist;

                joystickHandle.style.transform = `translate(calc(-50% + ${handleX}px), calc(-50% + ${handleY}px))`;

                joystickVec.x = handleX / maxRadius;
                joystickVec.y = handleY / maxRadius;
            }

            function handleJoyEnd(e) {
                if (!joystickActive) return;
                if (e && e.changedTouches && joyTouchId !== 'mouse') {
                    let joyEnded = false;
                    for (let t of e.changedTouches) {
                        if (t.identifier === joyTouchId) {
                            joyEnded = true;
                            break;
                        }
                    }
                    if (!joyEnded) return;
                }
                joystickActive = false;
                joyTouchId = null;
                joystickHandle.style.transform = `translate(-50%, -50%)`;
                joystickVec.x = 0;
                joystickVec.y = 0;
            }

            joystickZone.addEventListener('touchstart', handleJoyStart, { passive: false });
            window.addEventListener('touchmove', handleJoyMove, { passive: false });
            window.addEventListener('touchend', handleJoyEnd);
            window.addEventListener('touchcancel', handleJoyEnd);

            let isDraggingCam = false;
            let lastTouchX = 0;
            let lastTouchY = 0;
            let camTouchId = null;

            function isUIElement(target) {
                if (!target) return false;
                return target.closest('#start-screen, #exit-modal, #wheel-modal, #leaderboard-modal, #shop-modal, #payment-modal, #joystick-zone, #btn-jump, button');
            }

            window.addEventListener('touchstart', (e) => {
                for (let t of e.changedTouches) {
                    if (!isUIElement(t.target) && camTouchId === null) {
                        camTouchId = t.identifier;
                        lastTouchX = t.clientX;
                        lastTouchY = t.clientY;
                        isDraggingCam = true;
                        break;
                    }
                }
            }, { passive: false });

            window.addEventListener('touchmove', (e) => {
                if (!isDraggingCam) return;
                for (let t of e.changedTouches) {
                    if (t.identifier === camTouchId) {
                        const dx = t.clientX - lastTouchX;
                        const dy = t.clientY - lastTouchY;
                        lastTouchX = t.clientX;
                        lastTouchY = t.clientY;

                        cameraYaw -= dx * 0.006;
                        cameraPitch += dy * 0.006;
                        cameraPitch = Math.max(0.1, Math.min(1.2, cameraPitch));
                        break;
                    }
                }
            }, { passive: false });

            const endCamDrag = (e) => {
                if (e.changedTouches) {
                    for (let t of e.changedTouches) {
                        if (t.identifier === camTouchId) {
                            camTouchId = null;
                            isDraggingCam = false;
                            break;
                        }
                    }
                } else {
                    isDraggingCam = false;
                }
            };

            window.addEventListener('touchend', endCamDrag);
            window.addEventListener('touchcancel', endCamDrag);

            let isMouseDown = false;
            window.addEventListener('mousedown', (e) => {
                if (!isUIElement(e.target)) {
                    isMouseDown = true;
                    lastTouchX = e.clientX;
                    lastTouchY = e.clientY;
                }
            });

            window.addEventListener('mousemove', (e) => {
                if (isMouseDown) {
                    const dx = e.clientX - lastTouchX;
                    const dy = e.clientY - lastTouchY;
                    lastTouchX = e.clientX;
                    lastTouchY = e.clientY;

                    cameraYaw -= dx * 0.006;
                    cameraPitch += dy * 0.006;
                    cameraPitch = Math.max(0.1, Math.min(1.2, cameraPitch));
                }
            });

            window.addEventListener('mouseup', () => { isMouseDown = false; });
        }

        function triggerJump() {
            if (isGrounded && state.isPlaying && !state.isPaused) {
                playerVelocityY = 16.0;
                isGrounded = false;
                audio.playJump();
            }
        }

        function onWindowResize() {
            camera.aspect = window.innerWidth / window.innerHeight;
            camera.updateProjectionMatrix();
            renderer.setSize(window.innerWidth, window.innerHeight);
        }
