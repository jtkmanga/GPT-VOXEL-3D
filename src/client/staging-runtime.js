
// Assembled only by the staging builder. Default/P0-P8 client behavior is unchanged.
async function stagingGetIdToken(user, refresh = false) {
    try { return await user.getIdToken(refresh); }
    catch (_) { throw new Error('Staging authentication token is unavailable.'); }
}
loginWithGoogle = async function() {
    if (!STAGING_CLIENT_ENABLED) {
        alert('Staging authentication is not configured for this origin.');
        return false;
    }
    try {
        if (STAGING_PUBLIC_CONFIG.authMode === 'redirect') await auth.signInWithRedirect(googleProvider);
        else await auth.signInWithPopup(googleProvider);
        return true;
    } catch (_) {
        alert('Staging Google sign-in failed. Check the authorized staging domain.');
        return false;
    }
};
logoutGoogle = async function() {
    try { await auth.signOut(); return true; }
    catch (_) { alert('Staging sign-out failed.'); return false; }
};

// Rebuild testing never offers a real payment or sends a slip to a payment API.
openPaymentModal = function() {
    alert('Staging test entitlement events only. Real payments are disabled.');
    return false;
};
verifyAndBuySlip = async function() { return false; };
grantPurchasedItem = function() { return false; };
document.getElementById('slip-file-input').disabled = true;
document.getElementById('btn-verify-slip').disabled = true;
document.getElementById('promptpay-qr-img').src = '';
const stagingAuthoritativeStart = startGame;
startGame = async function() {
    if (!STAGING_CLIENT_ENABLED) { alert('Staging is not configured for this origin.'); return false; }
    return stagingAuthoritativeStart();
};

// Staging sends the exact ordered prediction intervals, rather than asking
// authority to apply the newest input to the preceding network-time window.
// Sequence ACKs therefore retire the same work on both sides of the socket.
function secureUseContinuousHandoff(serverId = state.selectedServerId) {
    return STAGING_CLIENT_ENABLED && serverId === 'free1' && state.selectedServerId === 'free1';
}
function stagingContinuousOperation() {
    if (!secureUseContinuousHandoff() || typeof secureActiveHandoff === 'undefined' ||
        !secureActiveHandoff?.continuous || !secureHandoffOperationIsCurrent(secureActiveHandoff)) return null;
    return secureActiveHandoff;
}
function secureBeginContinuousHandoff(operation, message, fromZone, targetZone) {
    if (!secureUseContinuousHandoff() || message.continuousHandoff !== true) return;
    Object.assign(operation, { continuous: true, fromZone, targetZone, confirmed: false, sealed: false });
}
function secureContinuousHandoffPredictionAllowed() {
    const operation = stagingContinuousOperation();
    return Boolean(operation && !operation.failed &&
        (operation.source?.readyState === WebSocket.OPEN || operation.target?.readyState === WebSocket.OPEN));
}
function stagingMovementSocket() {
    if (!secureHandoffInProgress) return secureGameSocket;
    const operation = stagingContinuousOperation();
    if (!operation) return null;
    if (operation.failed) return null;
    if (operation.confirmed) return operation.target;
    return !operation.sealed && operation.source?.readyState === WebSocket.OPEN ? operation.source : null;
}
function secureHandoffEconomySocket() {
    return stagingMovementSocket();
}
function secureDispatchContinuousHandoffSocket(ws, message) {
    const operation = stagingContinuousOperation();
    if (!operation || !secureHandoffInProgress) return null;
    if (ws.secureAuthenticatedUid !== operation.uid || operation.failed) return false;
    if (ws === operation.source) {
        if (operation.confirmed) return false;
        if (message.type === protocol.WS_MESSAGE.MOVE && message.sealed && message.applied === false) operation.sealed = true;
        if (message.type === protocol.WS_MESSAGE.AUTH_REFRESHED) {
            if (message.serverNow) secureSetServerNow(message.serverNow);
            secureTrackAuthenticatedSocket(ws, operation.fromZone, message.session);
            if (message.entitlements && typeof secureApplyEntitlements === 'function') {
                secureApplyEntitlements(message.entitlements, null, message.serverNow);
            }
            return false;
        }
        return [protocol.WS_MESSAGE.MOVE, protocol.WS_MESSAGE.JOIN, protocol.WS_MESSAGE.LEAVE,
            protocol.WS_MESSAGE.GHOST_SNAPSHOT, protocol.WS_MESSAGE.SCORE, protocol.WS_MESSAGE.LEADERBOARD,
            protocol.WS_MESSAGE.COIN_COLLECT_RESULT, protocol.WS_MESSAGE.COIN_COLLECTED,
            protocol.WS_MESSAGE.COIN_STATE, protocol.WS_MESSAGE.BOX_STATE,
            protocol.WS_MESSAGE.HANDOFF_CANCELLED, protocol.WS_MESSAGE.HANDOFF_ERROR,
            protocol.WS_MESSAGE.SERVER_ERROR].includes(message.type);
    }
    if (ws !== secureGameSocket || (operation.target && ws !== operation.target)) return false;
    if (operation.confirmed) return true;
    if ([protocol.WS_MESSAGE.COIN_STATE, protocol.WS_MESSAGE.COIN_COLLECTED, protocol.WS_MESSAGE.BOX_STATE,
        protocol.WS_MESSAGE.SCORE, protocol.WS_MESSAGE.LEADERBOARD].includes(message.type)) {
        // The server may send the commit's world snapshot immediately before
        // its ownership ACK. Preserve that snapshot without letting provisional
        // authority change rendered economy state before a validated cutover.
        operation.worldMessages ||= new Map();
        operation.worldMessages.set(message.type === protocol.WS_MESSAGE.COIN_COLLECTED
            ? `${message.type}:${message.id}` : message.type, message);
        if (operation.worldMessages.size > 204) {
            operation.failed = true;
            secureAbortClientConnections('Invalid continuous handoff world snapshot', 1008);
            secureReturnToMenu();
        }
        return false;
    }
    // Provisional sockets may acknowledge ownership, never write movement or
    // economy state over the still-owning source before that acknowledgement.
    return [protocol.WS_MESSAGE.HANDOFF_RESUMED, protocol.WS_MESSAGE.HANDOFF_RESUME_ERROR,
        protocol.WS_MESSAGE.HANDOFF_ERROR, protocol.WS_MESSAGE.AUTH_ERROR,
        protocol.WS_MESSAGE.SERVER_ERROR].includes(message.type);
}
function stagingReplayMovementGroups(ws, ack) {
    const groups = new Map();
    for (const frame of securePendingFrames) {
        if (frame.seq <= ack) continue;
        if (!groups.has(frame.seq)) groups.set(frame.seq, []);
        groups.get(frame.seq).push({ input: { ...frame.input }, delta: frame.delta });
    }
    for (const [seq, frames] of [...groups].sort((a, b) => a[0] - b[0])) {
        if (!movement.validMovementFrames(frames)) throw new Error('Continuous handoff prediction is invalid');
        const pending = securePendingInputs.find(packet => packet.seq === seq);
        const input = pending?.input || frames.at(-1).input;
        ws.send(JSON.stringify({ type: protocol.WS_MESSAGE.MOVE, input, seq, frames }));
        if (!pending) securePendingInputs.push({ seq, input, jumpGeneration: secureJumpGeneration });
        secureInputSequence = Math.max(secureInputSequence, seq + 1);
    }
    secureLastMoveSentAt = Date.now();
}
function stagingReconcileTransferAuthority(message) {
    const position = message.position, motion = message.movement || message.motion;
    const ack = Number(message.ack ?? motion?.lastSeq);
    if (!position || !motion || !Number.isSafeInteger(ack) || ack < -1 ||
        ack < secureLastAcknowledgedSequence || ack >= secureInputSequence ||
        (Object.hasOwn(motion, 'lastSeq') && motion.lastSeq !== ack) ||
        !['x', 'y', 'z', 'r'].every(key => Number.isFinite(position[key])) ||
        Math.abs(position.x) > movement.MOVEMENT.bounds || Math.abs(position.z) > movement.MOVEMENT.bounds ||
        position.y < 0 || position.y > 8 ||
        !['vx', 'vy', 'vz'].every(key => Number.isFinite(motion[key])) ||
        Math.hypot(motion.vx, motion.vz) > movement.MOVEMENT.entitledSpeed + 1e-6 ||
        Math.abs(motion.vy) > 128 || typeof motion.grounded !== 'boolean' ||
        typeof motion.jumpHeld !== 'boolean') return false;
    const before = { x: playerPos.x, y: playerPos.y, z: playerPos.z };
    if (securePendingInputs.some(packet => packet.seq <= ack && packet.input.jump &&
        packet.jumpGeneration === secureJumpGeneration)) secureJumpIntent = false;
    while (securePendingFrames.length && securePendingFrames[0].seq <= ack) securePendingFrames.shift();
    while (securePendingInputs.length && securePendingInputs[0].seq <= ack) securePendingInputs.shift();
    secureLastAcknowledgedSequence = ack;
    let corrected = { ...position, vx: motion.vx, vy: motion.vy, vz: motion.vz,
        grounded: Boolean(motion.grounded), jumpHeld: Boolean(motion.jumpHeld) };
    const options = secureMovementOptions();
    for (const frame of securePendingFrames) {
        corrected = movement.integrateMovement(corrected, frame.input, frame.delta, { ...options, speed: frame.speed });
    }
    secureApplyMovementState(corrected);
    if (Math.hypot(before.x - corrected.x, before.y - corrected.y, before.z - corrected.z) <= 4) {
        securePredictionCorrection.x += before.x - corrected.x;
        securePredictionCorrection.y += before.y - corrected.y;
        securePredictionCorrection.z += before.z - corrected.z;
    } else {
        securePredictionCorrection.x = securePredictionCorrection.y = securePredictionCorrection.z = 0;
    }
    return true;
}
function secureApplyContinuousHandoffAck(message) {
    const operation = stagingContinuousOperation();
    if (!operation || !secureHandoffInProgress || !secureHandoffResumeResolve ||
        !operation.target || secureGameSocket !== operation.target || message.zone !== operation.targetZone ||
        !stagingReconcileTransferAuthority(message)) return false;
    operation.confirmed = true;
    try { stagingReplayMovementGroups(operation.target, secureLastAcknowledgedSequence); }
    catch (_) { operation.failed = true; return false; }
    for (const event of operation.worldMessages?.values() || []) secureHandleSocketMessage(event);
    operation.worldMessages?.clear();
    return true;
}
function secureApplyContinuousHandoffCancel(message) {
    const operation = stagingContinuousOperation();
    if (!operation || !operation.cancelResolve || secureGameSocket !== operation.source ||
        message.zone !== operation.fromZone || !stagingReconcileTransferAuthority(message)) return false;
    operation.sealed = false;
    try { stagingReplayMovementGroups(operation.source, secureLastAcknowledgedSequence); }
    catch (_) { operation.failed = true; return false; }
    operation.worldMessages?.clear();
    const resolve = operation.cancelResolve;
    operation.cancelResolve = operation.cancelReject = null;
    if (operation.cancelTimer) clearTimeout(operation.cancelTimer);
    operation.cancelTimer = null;
    resolve(message);
    return true;
}
function secureContinuousHandoffDefersWelcomeWorld() {
    return Boolean(stagingContinuousOperation());
}
function secureContinuousHandoffRequiresAck() {
    return Boolean(stagingContinuousOperation());
}
function secureContinuousHandoffSocketOpened(ws, handoffToken) {
    const operation = stagingContinuousOperation();
    if (operation && handoffToken && ws !== operation.source) operation.target = ws;
}
function secureContinuousHandoffSocketClosed(ws, event) {
    const operation = stagingContinuousOperation();
    if (!operation || operation.confirmed || secureIntentionalSockets.has(ws)) return;
    if (ws === operation.source) {
        // Different sockets have no shared delivery order. Source closure after
        // cutover can precede the target's ownership ACK on the wire. Retain only
        // the bounded in-flight prediction window while that ACK is pending.
        if (operation.target?.readyState === WebSocket.OPEN && secureHandoffResumeResolve) {
            operation.sealed = true;
            return;
        }
        operation.failed = true;
        secureAbortClientConnections('Continuous handoff source disconnected', event.code);
        secureReturnToMenu();
    } else if (ws === operation.target && secureHandoffResumeReject) {
        const reject = secureHandoffResumeReject;
        if (secureHandoffResumeTimer) clearTimeout(secureHandoffResumeTimer);
        secureHandoffResumeTimer = null;
        secureHandoffResumeResolve = secureHandoffResumeReject = null;
        reject(new Error('Continuous handoff target disconnected'));
    }
}
function secureAbortContinuousHandoff(operation, reason) {
    if (operation.cancelTimer) clearTimeout(operation.cancelTimer);
    operation.cancelTimer = null;
    const reject = operation.cancelReject;
    operation.cancelResolve = operation.cancelReject = null;
    if (reject) reject(new Error(reason));
}
function secureFinishContinuousHandoff(operation) {
    secureAbortContinuousHandoff(operation, 'Continuous handoff finished');
}
async function secureCancelContinuousHandoff(operation, targetSocket, fromZone) {
    if (!secureHandoffOperationIsCurrent(operation)) return;
    if (targetSocket && targetSocket !== operation.source) secureCloseSocket(targetSocket, 1000, 'Continuous handoff cancelled');
    if (operation.source?.readyState !== WebSocket.OPEN) {
        operation.failed = true;
        secureReturnToMenu();
        return;
    }
    secureGameSocket = operation.source;
    secureGameReady = true;
    secureCurrentZoneId = fromZone;
    try {
        const acknowledged = new Promise((resolve, reject) => {
            operation.cancelResolve = resolve;
            operation.cancelReject = reject;
            operation.cancelTimer = setTimeout(() => reject(new Error('Continuous handoff cancellation timed out')), 3200);
        });
        operation.source.send(JSON.stringify({ type: protocol.WS_MESSAGE.HANDOFF_CANCEL }));
        await acknowledged;
        secureRequireHandoffOperation(operation);
        secureHandoffInProgress = false;
        secureRememberStablePosition();
    } catch (_) {
        if (secureHandoffOperationIsCurrent(operation)) {
            operation.failed = true;
            secureAbortClientConnections('Continuous handoff authority is unavailable', 1008);
            secureReturnToMenu();
        }
    }
}
let stagingPredictionResetPending = true;
const stagingResetPrediction = typeof secureResetPrediction === 'function' ? secureResetPrediction : null;
if (stagingResetPrediction) secureResetPrediction = function(position, motion = {}) {
    const reset = stagingResetPrediction(position, motion);
    if (reset) stagingPredictionResetPending = true;
    return reset;
};
function stagingUnsentMovementFrames() {
    return securePendingFrames.filter(frame => frame.seq === secureInputSequence);
}
syncMyPlayerData = function(force = false) {
    const socket = stagingMovementSocket();
    if (!STAGING_CLIENT_ENABLED || !state.isPlaying || !secureGameReady ||
        !socket || socket.readyState !== WebSocket.OPEN) return false;
    const now = Date.now();
    if (!force && now - secureLastMoveSentAt < config.MOVE_TICK_MS) return false;
    const input = state.isPaused ? { x: 0, z: 0, jump: false } : secureMovementIntent();
    const predicted = stagingUnsentMovementFrames();
    const frames = predicted.length
        ? predicted.map(frame => ({ input: { ...frame.input }, delta: frame.delta }))
        : [{ input, delta: 0 }];
    if (!movement.validMovementFrames(frames)) return false;
    const seq = secureInputSequence;
    try {
        socket.send(JSON.stringify({ type: protocol.WS_MESSAGE.MOVE, input, seq, frames }));
    } catch (_) { return false; }
    secureInputSequence++;
    secureLastMoveSentAt = now;
    securePendingInputs.push({ seq, input, jumpGeneration: secureJumpGeneration });
    if (securePendingInputs.length > 64) securePendingInputs.shift();
    return true;
};
function secureFlushMovementForPickup() {
    const socket = stagingMovementSocket();
    if (!STAGING_CLIENT_ENABLED || !state.isPlaying || !secureGameReady ||
        !socket || socket.readyState !== WebSocket.OPEN) return false;
    return stagingUnsentMovementFrames().length === 0 || syncMyPlayerData(true);
}
const stagingPredictMovement = typeof securePredictMovement === 'function' ? securePredictMovement : null;
if (stagingPredictMovement) securePredictMovement = function(delta) {
    if (!STAGING_CLIENT_ENABLED || !secureGameReady || (secureHandoffInProgress && !secureContinuousHandoffPredictionAllowed()) || !secureGameSocket ||
        secureGameSocket.readyState !== WebSocket.OPEN) return;
    // Reset/spawn/handoff authority starts a new prediction timeline. The
    // render delta from before that reset cannot claim pre-session movement.
    const elapsed = stagingPredictionResetPending ? 0
        : Math.min(.1, Math.max(0, Number.isFinite(delta) ? delta : 0));
    stagingPredictionResetPending = false;
    const unsent = stagingUnsentMovementFrames();
    const pendingSeconds = unsent.reduce((total, frame) => total + frame.delta, 0);
    const operation = stagingContinuousOperation();
    if (operation?.sealed && securePendingFrames.reduce((total, frame) => total + frame.delta, 0) + elapsed > .5) return;
    if (unsent.length >= 63 || pendingSeconds + elapsed > .5 + 1e-9) {
        if (!syncMyPlayerData(true)) return;
    }
    stagingPredictMovement(elapsed);
    const next = stagingUnsentMovementFrames();
    if (next.length >= 48 || next.reduce((total, frame) => total + frame.delta, 0) >= .45) {
        syncMyPlayerData(true);
    }
};

let stagingForegroundRefresh = null;
function stagingClearInput() {
    for (const key of Object.keys(keys)) keys[key] = false;
    joystickVec.x = joystickVec.y = 0;
    secureJumpIntent = false;
    secureJumpHeld = false;
}
async function stagingResumeForeground() {
    if (!STAGING_CLIENT_ENABLED || document.hidden || !state.isPlaying || !auth.currentUser) return false;
    if (stagingForegroundRefresh) return stagingForegroundRefresh;
    const user = auth.currentUser, uid = user.uid, epoch = secureConnectionEpoch();
    const ws = secureGameSocket, serverId = state.selectedServerId;
    stagingForegroundRefresh = (async () => {
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            if (secureReconnectInProgress) return false;
            return secureResumeDisconnectedSocket(secureCurrentZoneId, uid, serverId);
        }
        try {
            const token = await user.getIdToken(true);
            if (auth.currentUser !== user || auth.currentUser?.uid !== uid ||
                !secureConnectionIsCurrent(epoch) || secureGameSocket !== ws || ws.readyState !== WebSocket.OPEN ||
                state.selectedServerId !== serverId) return false;
            ws.send(JSON.stringify({ type: protocol.WS_MESSAGE.AUTH, token,
                protocol: serverId === 'vip1' ? protocol.PROTOCOL_VERSION.LEGACY_ROOM : protocol.PROTOCOL_VERSION.ZONE_ROOM }));
            return true;
        } catch (_) {
            if (auth.currentUser === user && secureConnectionIsCurrent(epoch) && secureGameSocket === ws) {
                secureCloseSocket(ws, 1008, 'Staging foreground authentication failed');
                secureReturnToMenu();
            }
            return false;
        }
    })();
    try { return await stagingForegroundRefresh; }
    finally { stagingForegroundRefresh = null; }
}
document.addEventListener('visibilitychange', () => {
    stagingClearInput();
    if (!document.hidden) void stagingResumeForeground();
});
window.addEventListener('online', () => { void stagingResumeForeground(); });
window.addEventListener('pagehide', () => {
    stagingClearInput();
    secureAbortClientConnections('Staging page hidden');
});
window.addEventListener('pageshow', event => {
    if (event.persisted) void stagingResumeForeground();
});

if (!STAGING_CLIENT_ENABLED) {
    document.getElementById('staging-status').innerText = 'STAGING NOT CONFIGURED · AUTH/GAMEPLAY DISABLED';
    document.getElementById('btn-google-login').disabled = true;
    document.getElementById('btn-start-game').disabled = true;
} else if (STAGING_PUBLIC_CONFIG.authMode === 'redirect') {
    auth.getRedirectResult().catch(() => {
        alert('Staging Google redirect could not complete. Check the authorized staging domain.');
    });
}
