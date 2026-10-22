#!/usr/bin/env python3
"""P9 generated staging client in mobile Chromium emulation, with no external I/O.

The Firebase SDK and WebSocket transport are deterministic fixtures, served by
Playwright interception at a synthetic HTTPS staging origin. Real local Three.js
r128/WebGL runs. This is not a deployed staging service or a physical Android test.
"""
import json
from pathlib import Path
import subprocess
import sys
import time
from urllib.parse import urlsplit

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
THREE = ROOT / "node_modules/three/build/three.min.js"
ORIGIN = "https://gpt-voxel-3d-staging-p9-fixture.invalid"
WRONG_ORIGIN = "https://gpt-voxel-3d-staging-unapproved.invalid"
PUBLIC = {
    "environment": "staging", "workerName": "gpt-voxel-3d-staging-p9-fixture", "workerOrigin": ORIGIN,
    "firebase": {"apiKey": "synthetic-public-staging-key", "authDomain": "voxel-staging-fixture.firebaseapp.com",
                 "projectId": "voxel-staging-fixture", "appId": "1:123456789:web:abcdef1234567890"},
    "appCheck": {"provider": "recaptcha-enterprise", "siteKey": "6L" + ("A" * 38)},
    "authMode": "popup",
}
TIMEOUT = 45_000

FIXTURE = r"""
(() => {
  const calls = { configs: [], popup: 0, redirect: 0, redirectResults: 0, tokenRefreshes: 0,
    appCheckActivations: [], database: 0, sockets: [], packets: [], http: [] };
  const callbacks = [];
  const user = { uid: 'synthetic-p9-browser-user', displayName: 'Stage Player', email: '',
    photoURL: 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg"/%3E',
    async getIdToken(refresh) { if (refresh) calls.tokenRefreshes++; return 'synthetic-p9-browser-id-token'; } };
  const auth = {
    currentUser: localStorage.getItem('p9-synthetic-login') ? user : null,
    onAuthStateChanged(callback) { callbacks.push(callback); queueMicrotask(() => callback(this.currentUser)); return () => {}; },
    async signInWithPopup() { calls.popup++; this.currentUser = user; localStorage.setItem('p9-synthetic-login', 'yes');
      callbacks.forEach(callback => callback(user)); return { user }; },
    async signInWithRedirect() { calls.redirect++; localStorage.setItem('p9-synthetic-login', 'yes'); },
    async getRedirectResult() { calls.redirectResults++; return { user: this.currentUser }; },
    async signOut() { this.currentUser = null; localStorage.removeItem('p9-synthetic-login'); callbacks.forEach(callback => callback(null)); }
  };
  function authFactory() { return auth; }
  authFactory.GoogleAuthProvider = class SyntheticGoogleProvider {};
  function appCheckFactory() {
    return { activate(provider, autoRefresh) { calls.appCheckActivations.push({ key: provider.key, autoRefresh }); } };
  }
  appCheckFactory.ReCaptchaEnterpriseProvider = class SyntheticEnterpriseProvider {
    constructor(key) { this.key = key; }
  };
  window.firebase = { initializeApp(config) { calls.configs.push(config); }, auth: authFactory, appCheck: appCheckFactory,
    database() { calls.database++; throw Error('The staging client must not initialize Firebase gameplay data'); } };
  window.__p9 = calls;
  class SyntheticSocket {
    static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
    constructor(url) {
      this.url = String(url); this.readyState = 0; this.session = null; calls.sockets.push(this);
      const parsed = new URL(this.url);
      if (parsed.origin !== location.origin.replace('https:', 'wss:') || parsed.pathname !== '/play') throw Error('Wrong staging socket origin');
      queueMicrotask(() => { this.readyState = 1; this.onopen?.(); });
    }
    receive(packet) { this.onmessage?.({ data: JSON.stringify(packet) }); }
    send(raw) {
      if (this.readyState !== 1) throw Error('Inactive staging fixture socket');
      const packet = JSON.parse(raw); calls.packets.push(packet);
      const now = Date.now();
      if (packet.type === 'auth') {
        if (packet.token !== 'synthetic-p9-browser-id-token') throw Error('SDK token was not forwarded');
        const vip = new URL(this.url).searchParams.get('server') === 'vip1';
        if (packet.protocol !== (vip ? 4 : 6)) throw Error('Wrong selected-room protocol');
        const fresh = !this.session;
        this.session = { sessionId: 'synthetic-p9-session', resumeToken: 'synthetic-p9-resume',
          resumeExpiresAt: now + 120000, tokenExpiresAt: now + 3600000 };
        queueMicrotask(() => this.receive(fresh ? {
          type: 'welcome', id: 'synthetic-p9-stable-player', name: 'Stage', server: vip ? 'vip1' : 'free1',
          protocol: vip ? 4 : 6, zone: '5,5', spawn: { x: 0, y: 0, z: 0, r: 0 }, movement: { lastSeq: -1 },
          players: [], coins: [], luckyBox: { active: false, x: 200, z: 200, cycle: 1, nextSpawn: now + 14400000 },
          leaderboard: [{ name: 'Stage', score: 17 }], score: 17, serverNow: now, session: this.session,
          resumed: packet.resumeToken === 'synthetic-p9-resume'
        } : { type: 'auth_refreshed', session: this.session, serverNow: now, entitlements: { vip1Expires: now + 86400000 } }));
      } else if (packet.type === 'move') {
        queueMicrotask(() => this.receive({ type: 'move', player: { id: 'synthetic-p9-stable-player', x: 0, y: 0, z: 0, r: 0 },
          ack: packet.seq, applied: true, serverNow: now, movement: { vx: 0, vy: 0, vz: 0, grounded: true } }));
      }
    }
    close(code = 1000) { if (this.readyState === 3) return; this.readyState = 3; this.onclose?.({ code }); }
  }
  window.WebSocket = SyntheticSocket;
})();
"""


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def build(public):
    script = "const fs=require('node:fs');const {buildStagingClient}=require('./scripts/rebuild/build-staging-client.cjs');" \
        "let raw='';process.stdin.on('data',s=>raw+=s);process.stdin.on('end',async()=>{" \
        "try{process.stdout.write(await buildStagingClient(JSON.parse(raw),{allowTest:true}));}catch(e){process.exitCode=1;}});"
    result = subprocess.run(["node", "-e", script], cwd=ROOT, input=json.dumps(public), text=True, capture_output=True, check=True)
    return result.stdout


def run():
    html = build(PUBLIC)
    redirect_html = build({**PUBLIC, "authMode": "redirect"})
    disabled_html = build({"environment": "staging", "configured": False, "authMode": "popup"})
    require(THREE.is_file(), "Pinned Three.js fixture is missing")
    cases = 0
    errors, unexpected, dialogs = [], [], []
    current_html = {"value": html}

    def passed(label):
        nonlocal cases
        cases += 1
        print(f"PASS P9 browser: {label}", flush=True)

    def route_request(route):
        parsed = urlsplit(route.request.url)
        if parsed.hostname in (urlsplit(ORIGIN).hostname, urlsplit(WRONG_ORIGIN).hostname):
            if parsed.path in ("/", "/index.html"):
                route.fulfill(status=200, content_type="text/html", body=current_html["value"])
                return
            if parsed.path == "/entitlements":
                require(route.request.headers.get("authorization") == "Bearer synthetic-p9-browser-id-token", "Entitlement request bypassed SDK token")
                route.fulfill(status=200, content_type="application/json", body=json.dumps({"ok": True,
                    "entitlements": {"vip1Expires": 4_000_000_000_000}, "serverNow": int(time.time() * 1000),
                    "servers": {"vip1": {"count": 0, "max": 100}}}))
                return
        if parsed.hostname == "cdn.tailwindcss.com":
            route.fulfill(content_type="application/javascript", body="/* isolated styling fixture */")
            return
        if parsed.hostname == "cdnjs.cloudflare.com" and parsed.path == "/ajax/libs/three.js/r128/three.min.js":
            route.fulfill(content_type="application/javascript", body=THREE.read_bytes())
            return
        if parsed.hostname == "www.gstatic.com" and parsed.path in (
            "/firebasejs/10.8.0/firebase-app-compat.js", "/firebasejs/10.8.0/firebase-auth-compat.js",
            "/firebasejs/10.8.0/firebase-app-check-compat.js", "/firebasejs/10.8.0/firebase-database-compat.js"
        ):
            route.fulfill(content_type="application/javascript", body="/* Firebase fixture installed before scripts */")
            return
        if (parsed.hostname == "cdnjs.cloudflare.com" and parsed.path == "/ajax/libs/font-awesome/6.4.0/css/all.min.css") or parsed.hostname == "fonts.googleapis.com":
            route.fulfill(content_type="text/css", body="/* isolated CSS fixture */")
            return
        # Redacted paths only: no tokens, authorization headers, payloads or query strings.
        unexpected.append(f"{parsed.scheme}://{parsed.hostname}{parsed.path}")
        route.abort("blockedbyclient")

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path="/usr/bin/chromium", headless=True, timeout=TIMEOUT,
            args=["--no-sandbox", "--disable-dev-shm-usage", "--enable-webgl", "--use-gl=angle", "--use-angle=swiftshader",
                  "--enable-unsafe-swiftshader", "--disable-background-networking", "--disable-component-update",
                  "--disable-sync", "--no-first-run", "--host-resolver-rules=MAP * ~NOTFOUND"])
        context = browser.new_context(viewport={"width": 393, "height": 851}, is_mobile=True, has_touch=True,
            device_scale_factor=1, service_workers="block",
            user_agent="Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36")
        context.set_default_timeout(TIMEOUT)
        context.route("**/*", route_request)
        context.add_init_script(FIXTURE)
        page = context.new_page()
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.on("dialog", lambda dialog: (dialogs.append(dialog.message), dialog.dismiss()))
        try:
            page.goto(ORIGIN, wait_until="load")
            page.wait_for_function("typeof renderer !== 'undefined' && !!renderer && typeof stagingResumeForeground === 'function'")
            require(page.evaluate("THREE.REVISION === '128' && renderer instanceof THREE.WebGLRenderer && !renderer.getContext().isContextLost()"), "Staging generated client failed real WebGL")
            require(page.evaluate("STAGING_CLIENT_ENABLED && __p9.configs.length === 1 && __p9.database === 0 && __p9.configs[0].projectId === 'voxel-staging-fixture'"), "Wrong staging SDK configuration")
            require(page.evaluate("__p9.appCheckActivations.length === 1 && __p9.appCheckActivations[0].autoRefresh === true && __p9.appCheckActivations[0].key === STAGING_PUBLIC_CONFIG.appCheck.siteKey"), "App Check was not activated with auto-refresh")
            require(page.evaluate("innerWidth === 393 && navigator.maxTouchPoints > 0 && navigator.userAgent.includes('Android')"), "Mobile browser emulation was not applied")
            passed("isolated HTTPS staging client loads real WebGL in mobile Chromium emulation")

            page.evaluate("loginWithGoogle()")
            page.wait_for_function("state.isLoggedIn && auth.currentUser?.uid === 'synthetic-p9-browser-user'")
            require(page.evaluate("__p9.popup === 1 && __p9.redirect === 0"), "Configured popup flow did not run")
            page.evaluate("selectFreeServer('free1'); startGame()")
            page.wait_for_function("state.isPlaying && secureGameReady && !!secureGameSocket")
            require(page.evaluate("new URL(secureGameSocket.url).protocol === 'wss:' && new URL(secureGameSocket.url).hostname === location.hostname && !new URL(secureGameSocket.url).searchParams.has('server')"), "Free WebSocket escaped staging")
            require(page.evaluate("state.score === 17 && state.serverPlayerId === 'synthetic-p9-stable-player' && __p9.packets.find(p => p.type === 'auth').protocol === 6"), "Welcome did not bind client identity/state")
            passed("Google fixture identity enters Free through the staging WSS and authoritative welcome")

            before = page.evaluate("__p9.sockets.length")
            page.evaluate("window.__p9oldSocket = secureGameSocket; secureGameSocket.close(1006)")
            page.wait_for_function(f"secureGameReady && __p9.sockets.length === {before + 1}")
            require(page.evaluate("__p9.packets.filter(p => p.type === 'auth').at(-1).resumeToken === 'synthetic-p9-resume' && state.serverPlayerId === 'synthetic-p9-stable-player'"), "Network interruption failed scoped resume")
            page.evaluate("__p9oldSocket.receive({type:'score',score:999999})")
            require(page.evaluate("state.score === 17"), "Stale old socket changed authoritative score")
            passed("network interruption resumes existing ownership and old-socket messages stay fenced")

            page.evaluate("keys.w=true; keys.d=true; joystickVec.x=1; secureJumpIntent=true; Object.defineProperty(document,'hidden',{configurable:true,value:true}); document.dispatchEvent(new Event('visibilitychange'))")
            require(page.evaluate("!keys.w && !keys.d && joystickVec.x === 0 && !secureJumpIntent"), "Background left held movement inputs")
            page.evaluate("Object.defineProperty(document,'hidden',{configurable:true,value:false}); document.dispatchEvent(new Event('visibilitychange'))")
            page.wait_for_function("__p9.tokenRefreshes >= 2")
            page.wait_for_function("stagingAuthRefreshCount >= 1 && document.getElementById('staging-status').innerText.includes('AUTH REFRESHED')")
            require(page.evaluate("secureGameReady && state.isPlaying"), "Foreground did not retain current authoritative session")
            require(page.evaluate("document.getElementById('staging-status').innerText.includes('TEST PAYMENTS ONLY')"), "Staging refresh evidence hid the payment boundary")
            page.evaluate("window.dispatchEvent(new Event('pagehide')); window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}))")
            page.wait_for_function(f"secureGameReady && __p9.sockets.length === {before + 2}")
            passed("emulated background/foreground and persisted-page recovery preserve scoped authentication")

            page.evaluate("confirmExitGame(); selectVipServer('vip1').then(()=>startGame())")
            page.wait_for_function("state.isPlaying && secureGameReady && state.selectedServerId === 'vip1'")
            require(page.evaluate("new URL(secureGameSocket.url).searchParams.get('server') === 'vip1' && __p9.packets.filter(p=>p.type==='auth').at(-1).protocol === 4"), "VIP staging route/protocol is wrong")
            require(page.evaluate("document.body.innerText.includes('Free Server ฟรีไม่จำกัด') && document.body.innerText.includes('ไม่จำกัดผู้เล่น') && document.body.innerText.includes('50 บาท/เดือน')"), "Product labels changed")
            passed("trusted entitlement fixture selects isolated VIP while preserving Free and 50 THB labels")

            page.evaluate("for(const type of ['speed','coin']) openPaymentModal(type,1,'forged'); verifyAndBuySlip()")
            require(page.evaluate("document.getElementById('btn-verify-slip').disabled && document.getElementById('slip-file-input').disabled && document.getElementById('promptpay-qr-img').getAttribute('src') === ''"), "Payment remained enabled in staging")
            require(all("sensitive" not in dialog for dialog in dialogs), "Sensitive SDK error reached a dialog")
            passed("legacy speed, coin, QR and slip entrypoints remain disabled; VIP sandbox is covered separately")

            page.reload(wait_until="load")
            page.wait_for_function("state.isLoggedIn && typeof stagingResumeForeground === 'function'")
            page.evaluate("selectFreeServer('free1'); startGame()")
            page.wait_for_function("state.isPlaying && secureGameReady")
            require(page.evaluate("state.serverPlayerId === 'synthetic-p9-stable-player' && __p9.packets.find(p=>p.type==='auth').resumeToken === undefined"), "Reload leaked/stored a session capability")
            passed("page reload restores SDK identity and fresh authority without browser-persisted resume tokens")

            current_html["value"] = redirect_html
            page.reload(wait_until="load")
            page.wait_for_function("typeof stagingResumeForeground === 'function' && __p9.redirectResults === 1")
            page.evaluate("loginWithGoogle()")
            require(page.evaluate("__p9.redirect === 1 && __p9.popup === 0"), "Configured mobile redirect used popup")
            passed("configured mobile Google redirect consumes the SDK redirect result")

            current_html["value"] = disabled_html
            page.reload(wait_until="load")
            page.wait_for_function("typeof stagingResumeForeground === 'function'")
            page.evaluate("loginWithGoogle(); selectFreeServer('free1'); startGame()")
            require(page.evaluate("!STAGING_CLIENT_ENABLED && __p9.configs.length === 0 && __p9.sockets.length === 0 && !state.isPlaying && document.getElementById('btn-google-login').disabled"), "Unconfigured staging fell back to production authentication/gameplay")
            passed("missing staging credentials produce a disabled client with no production fallback")

            current_html["value"] = html
            page.goto(WRONG_ORIGIN, wait_until="load")
            page.wait_for_function("typeof stagingResumeForeground === 'function'")
            page.evaluate("loginWithGoogle(); selectFreeServer('free1'); startGame()")
            require(page.evaluate("!STAGING_CLIENT_ENABLED && __p9.configs.length === 0 && __p9.sockets.length === 0 && !state.isPlaying"), "A copied staging client authenticated on an unapproved origin")
            passed("copied staging assets disable authentication/gameplay on an unapproved origin")

            require(not errors, f"Staging browser JavaScript error count: {len(errors)}")
            require(not unexpected, f"Unexpected request paths: {unexpected}")
            passed("zero external requests, JavaScript errors or physical-device claims")
        finally:
            context.close()
            browser.close()
    print(f"P9 browser cases: {cases} passed / 0 failed / 0 skipped", flush=True)


if __name__ == '__main__':
    try:
        run()
    except Exception:
        print("FAIL P9 browser: isolated staging assertion failed (request/SDK details redacted)", file=sys.stderr, flush=True)
        print("P9 browser result: failed / 0 skipped", file=sys.stderr, flush=True)
        sys.exit(1)
