
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
