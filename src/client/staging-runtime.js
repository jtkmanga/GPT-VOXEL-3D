
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
    if (!STAGING_CLIENT_ENABLED || !state.isPlaying || secureHandoffInProgress || !secureGameReady ||
        !secureGameSocket || secureGameSocket.readyState !== WebSocket.OPEN) return false;
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
        secureGameSocket.send(JSON.stringify({ type: protocol.WS_MESSAGE.MOVE, input, seq, frames }));
    } catch (_) { return false; }
    secureInputSequence++;
    secureLastMoveSentAt = now;
    securePendingInputs.push({ seq, input, jumpGeneration: secureJumpGeneration });
    if (securePendingInputs.length > 64) securePendingInputs.shift();
    return true;
};
function secureFlushMovementForPickup() {
    if (!STAGING_CLIENT_ENABLED || !state.isPlaying || secureHandoffInProgress || !secureGameReady ||
        !secureGameSocket || secureGameSocket.readyState !== WebSocket.OPEN) return false;
    return stagingUnsentMovementFrames().length === 0 || syncMyPlayerData(true);
}
const stagingPredictMovement = typeof securePredictMovement === 'function' ? securePredictMovement : null;
if (stagingPredictMovement) securePredictMovement = function(delta) {
    if (!STAGING_CLIENT_ENABLED || !secureGameReady || secureHandoffInProgress || !secureGameSocket ||
        secureGameSocket.readyState !== WebSocket.OPEN) return;
    // Reset/spawn/handoff authority starts a new prediction timeline. The
    // render delta from before that reset cannot claim pre-session movement.
    const elapsed = stagingPredictionResetPending ? 0
        : Math.min(.1, Math.max(0, Number.isFinite(delta) ? delta : 0));
    stagingPredictionResetPending = false;
    const unsent = stagingUnsentMovementFrames();
    const pendingSeconds = unsent.reduce((total, frame) => total + frame.delta, 0);
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
