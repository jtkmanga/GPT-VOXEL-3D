#!/usr/bin/env python3
"""P1 local browser gate: real r128/WebGL, synthetic Firebase, zero external I/O.

Requires Python Playwright, /usr/bin/chromium, and the pinned npm three@0.128.0
package. This checks the generated classic client and shared ESM load contracts;
the ordered classic source fragments deliberately do not run independently as ESM.
It does not validate real Firebase SDK behavior, production services, or devices.
"""

from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import sys
import threading
from urllib.parse import urlsplit

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[2]
THREE_PATH = ROOT / "node_modules/three/build/three.min.js"
TIMEOUT_MS = 45_000

FIREBASE_FIXTURE = r"""
(() => {
    const calls = { initialized: 0, authCallbacks: 0, signIns: 0, dbReferences: 0 };
    const authState = {
        currentUser: null,
        onAuthStateChanged(callback) {
            queueMicrotask(() => { calls.authCallbacks++; callback(null); });
            return () => {};
        },
        signInWithPopup(provider) {
            if (!(provider instanceof authFactory.GoogleAuthProvider)) {
                return Promise.reject(new Error('Unexpected synthetic provider'));
            }
            calls.signIns++;
            return Promise.resolve({ user: null });
        },
        signOut() { return Promise.resolve(); }
    };
    function authFactory() { return authState; }
    authFactory.GoogleAuthProvider = class SyntheticGoogleAuthProvider {};
    function ref() {
        calls.dbReferences++;
        const result = {
            on() {}, off() {}, child() { return result; },
            set() { return Promise.resolve(); },
            remove() { return Promise.resolve(); },
            once() { return Promise.resolve({ val: () => null }); },
            transaction() { return Promise.resolve({ committed: false }); },
            onDisconnect() { return { remove() { return Promise.resolve(); } }; },
            orderByChild() { return result; }, limitToLast() { return result; }
        };
        return result;
    }
    window.__p1FirebaseCalls = calls;
    window.firebase = {
        initializeApp() { calls.initialized++; },
        auth: authFactory,
        database() { return { ref }; }
    };
})();
"""

ISOLATION_FIXTURE = r"""
(() => {
    window.__p1BlockedSockets = [];
    const NativeWebSocket = window.WebSocket;
    class BlockedWebSocket {
        constructor(url) {
            window.__p1BlockedSockets.push(String(url));
            throw new Error('P1 browser gate blocks all WebSocket network access');
        }
    }
    for (const key of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) {
        Object.defineProperty(BlockedWebSocket, key, { value: NativeWebSocket[key] });
    }
    window.WebSocket = BlockedWebSocket;
    localStorage.setItem('voxel_shop_speed_expire', String(Date.now() + 86400000));
    localStorage.setItem('voxel_shop_coin_expire', String(Date.now() + 86400000));
})();
"""


class LocalHandler(SimpleHTTPRequestHandler):
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".mjs": "text/javascript",
        ".js": "text/javascript",
    }

    def log_message(self, _format, *_args):
        pass


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def run():
    require(THREE_PATH.is_file(), "Missing pinned local Three.js r128 npm fixture")
    server = ThreadingHTTPServer(
        ("127.0.0.1", 0), partial(LocalHandler, directory=str(ROOT))
    )
    server.daemon_threads = True
    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()
    local_port = server.server_address[1]
    base_url = f"http://127.0.0.1:{local_port}"
    page_errors = []
    unexpected_requests = []
    dialogs = []
    cases = 0

    def passed(name):
        nonlocal cases
        cases += 1
        print(f"PASS P1 browser: {name}", flush=True)

    def route_request(route):
        request_url = route.request.url
        parsed = urlsplit(request_url)
        if (
            parsed.scheme == "http"
            and parsed.hostname == "127.0.0.1"
            and parsed.port == local_port
        ):
            route.continue_()
            return
        if parsed.hostname == "cdn.tailwindcss.com" and parsed.path in ("", "/"):
            route.fulfill(content_type="application/javascript", body="/* local UI fixture */")
            return
        if (
            parsed.hostname == "cdnjs.cloudflare.com"
            and parsed.path == "/ajax/libs/three.js/r128/three.min.js"
        ):
            route.fulfill(content_type="application/javascript", body=THREE_PATH.read_bytes())
            return
        if parsed.hostname == "www.gstatic.com" and parsed.path in (
            "/firebasejs/10.8.0/firebase-app-compat.js",
            "/firebasejs/10.8.0/firebase-auth-compat.js",
            "/firebasejs/10.8.0/firebase-database-compat.js",
        ):
            body = FIREBASE_FIXTURE if parsed.path.endswith("firebase-app-compat.js") else "/* fixture initialized */"
            route.fulfill(content_type="application/javascript", body=body)
            return
        if (
            parsed.hostname == "cdnjs.cloudflare.com"
            and parsed.path == "/ajax/libs/font-awesome/6.4.0/css/all.min.css"
        ) or (parsed.hostname == "fonts.googleapis.com" and parsed.path == "/css2"):
            route.fulfill(content_type="text/css", body="/* local CSS fixture */")
            return
        # Store no query strings, credentials, or bodies in the failure output.
        unexpected_requests.append(f"{parsed.scheme}://{parsed.hostname}{parsed.path}")
        route.abort("blockedbyclient")

    try:
        with sync_playwright() as playwright:
            browser = None
            context = None
            try:
                browser = playwright.chromium.launch(
                    executable_path="/usr/bin/chromium",
                    headless=True,
                    timeout=TIMEOUT_MS,
                    args=[
                        "--no-sandbox",
                        "--disable-dev-shm-usage",
                        "--enable-webgl",
                        "--use-gl=angle",
                        "--use-angle=swiftshader",
                        "--enable-unsafe-swiftshader",
                        "--disable-background-networking",
                        "--disable-component-update",
                        "--disable-domain-reliability",
                        "--disable-sync",
                        "--no-first-run",
                        "--safebrowsing-disable-auto-update",
                        # Also block speculative DNS/preconnect outside loopback.
                        "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
                    ],
                )
                context = browser.new_context(
                    viewport={"width": 1280, "height": 720}, service_workers="block"
                )
                context.set_default_timeout(TIMEOUT_MS)
                context.route("**/*", route_request)
                context.add_init_script(ISOLATION_FIXTURE)
                page = context.new_page()
                page.on("pageerror", lambda error: page_errors.append(str(error)))

                def dismiss_dialog(dialog):
                    dialogs.append({"type": dialog.type, "message": dialog.message})
                    dialog.dismiss()

                page.on("dialog", dismiss_dialog)
                response = page.goto(f"{base_url}/index.html", wait_until="load", timeout=TIMEOUT_MS)
                require(response is not None and response.status == 200, "Local generated index did not load")
                page.wait_for_function(
                    "typeof renderer !== 'undefined' && !!renderer && "
                    "window.__p1FirebaseCalls?.authCallbacks === 1",
                    timeout=TIMEOUT_MS,
                )
                render = page.evaluate("""() => ({
                    revision: THREE.REVISION,
                    renderer: renderer instanceof THREE.WebGLRenderer,
                    canvas: renderer.domElement === document.getElementById('game-canvas'),
                    width: renderer.domElement.width,
                    scene: scene instanceof THREE.Scene,
                    entities: scene.children.length,
                    player: playerGroup instanceof THREE.Group,
                    contextLost: renderer.getContext().isContextLost()
                })""")
                require(render["revision"] == "128", "Three.js fixture version changed")
                require(
                    render["renderer"] and render["canvas"] and render["scene"]
                    and render["player"] and render["width"] > 0
                    and render["entities"] > 600 and not render["contextLost"],
                    f"Generated client failed real Three.js/WebGL startup: {render}",
                )
                require(not page_errors, f"Browser startup JavaScript errors: {page_errors}")
                passed("generated entrypoint initializes real r128 scene, player and WebGL renderer")

                bootstrap = page.evaluate("""() => ({
                    user: state.userId,
                    loggedIn: state.isLoggedIn,
                    playing: state.isPlaying,
                    paused: state.isPaused,
                    score: state.score,
                    selected: state.selectedServerId,
                    ready: secureGameReady,
                    socket: secureGameSocket,
                    buffs: [state.shop.speedBuffExpires, state.shop.coinBuffExpires],
                    cachedBuffs: [localStorage.getItem('voxel_shop_speed_expire'),
                                  localStorage.getItem('voxel_shop_coin_expire')],
                    vip: state.vipServers.vip1,
                    mapSize: MAP_SIZE,
                    coins: MAX_COINS_PER_MAP,
                    coinRespawn: COIN_RESPAWN_MS,
                    boxRespawn: LUCKY_BOX_RESPAWN_MS,
                    fixture: window.__p1FirebaseCalls
                })""")
                require(
                    bootstrap["user"] is None and not bootstrap["loggedIn"]
                    and not bootstrap["playing"] and not bootstrap["paused"]
                    and bootstrap["score"] == 0 and bootstrap["selected"] is None
                    and not bootstrap["ready"] and bootstrap["socket"] is None
                    and bootstrap["buffs"] == [0, 0] and bootstrap["cachedBuffs"] == [None, None]
                    and bootstrap["vip"] == {"count": 0, "max": 100}
                    and bootstrap["mapSize"] == 1500 and bootstrap["coins"] == 200
                    and bootstrap["coinRespawn"] == 60_000
                    and bootstrap["boxRespawn"] == 14_400_000
                    and bootstrap["fixture"]["initialized"] == 1
                    and bootstrap["fixture"]["dbReferences"] == 0,
                    f"Logged-out P0 bootstrap contract changed: {bootstrap}",
                )
                passed("P0 logged-out state, settings and authoritative buff override remain intact")

                handlers = page.evaluate("""() => {
                    const names = new Set([
                        'loginWithGoogle', 'logoutGoogle', 'selectFreeServer', 'startGame',
                        'openHomeConfirmModal', 'toggleAudio', 'openFullLeaderboard',
                        'openShopModal', 'closeShopModal', 'openPaymentModal',
                        'closePaymentModal', 'verifyAndBuySlip', 'closeHomeConfirmModal',
                        'confirmExitGame', 'spinWheel', 'closeWheelModal',
                        'closeFullLeaderboard', 'selectVipServer'
                    ]);
                    for (const element of document.querySelectorAll('[onclick]')) {
                        const match = element.getAttribute('onclick').match(/^([A-Za-z_$][\\w$]*)\\(/);
                        if (!match) throw new Error('Unrecognized existing inline handler');
                        names.add(match[1]);
                    }
                    return [...names].map(name => ({name, callable: typeof window[name] === 'function'}));
                }""")
                require(all(handler["callable"] for handler in handlers), f"Global handler contract changed: {handlers}")
                passed("inline and dynamic UI handlers retain callable classic-script global bindings")

                page.keyboard.down("w")
                require(page.evaluate("keys.w === true"), "Real keyboard W keydown did not reach controls")
                page.keyboard.up("w")
                require(page.evaluate("keys.w === false"), "Real keyboard W keyup did not reach controls")
                passed("real browser keyboard down/up reaches the existing movement controls")

                modules = page.evaluate("""async () => {
                    const entry = await import('/src/client/entry.mjs');
                    window.__p1ClientEntry = entry;
                    return {
                        map: entry.config.SERVER_MAP_SIZE,
                        coins: entry.config.SERVER_COIN_COUNT,
                        tick: entry.config.MOVE_TICK_MS,
                        zones: entry.config.ZONE_GRID_SIZE,
                        messageCount: Object.keys(entry.protocol.WS_MESSAGE).length,
                        auth: entry.protocol.WS_MESSAGE.AUTH,
                        resume: entry.protocol.WS_MESSAGE.HANDOFF_RESUME,
                        versions: entry.protocol.PROTOCOL_VERSION,
                        vip: entry.catalog.CLIENT_PAYMENT_ITEMS.vip1,
                        rewards: entry.catalog.WHEEL_ITEMS.map(item => item.value),
                        sourceCount: entry.CLIENT_SOURCES.length
                    };
                }""")
                require(
                    modules["map"] == 1500 and modules["coins"] == 200
                    and modules["tick"] == 200 and modules["zones"] == 10
                    and modules["messageCount"] == 28 and modules["auth"] == "auth"
                    and modules["resume"] == "handoff_resume"
                    and modules["versions"] == {"LEGACY_ROOM": 4, "ZONE_ROOM": 6}
                    and modules["vip"] == {"price": 50, "title": "สิทธิ์ VIP Server 1 (30 วัน)"}
                    and modules["rewards"] == [100, 500, 1000, 5000, 9999]
                    and modules["sourceCount"] == 12,
                    f"Browser shared ESM contracts changed: {modules}",
                )
                passed("browser imports canonical client manifest and shared config/protocol/catalog ESM")

                sources = page.evaluate("""async () => {
                    return await Promise.all(window.__p1ClientEntry.CLIENT_SOURCES.map(async path => {
                        const response = await fetch(new URL(path, location.origin + '/src/client/entry.mjs'));
                        const body = await response.text();
                        return {path, status: response.status, length: body.length};
                    }));
                }""")
                require(len(sources) == 12 and all(source["status"] == 200 and source["length"] > 0 for source in sources), f"Local canonical sources unavailable: {sources}")
                passed("all 12 ordered classic source fragments load from loopback with HTTP 200")

                page.locator("#btn-google-login").evaluate("element => element.click()")
                require(page.evaluate("window.__p1FirebaseCalls.signIns === 1"), "Google-login inline handler did not call isolated auth fixture")
                page.locator("#action-free1 button").evaluate("element => element.click()")
                require(page.evaluate("state.selectedServerId === 'free1'"), "Free-server inline handler changed")
                page.locator("#btn-start-game").evaluate("element => element.click()")
                require(
                    len(dialogs) == 1 and dialogs[0]["type"] == "alert"
                    and "ล็อกอิน Google" in dialogs[0]["message"],
                    "Logged-out gameplay did not retain the existing sign-in requirement",
                )
                require(page.evaluate("!state.isPlaying && !secureGameReady && secureGameSocket === null"), "Logged-out start changed gameplay authority")
                passed("existing login/free-selection handlers execute and unauthenticated gameplay stays blocked")

                require(not page_errors, f"Browser JavaScript errors: {page_errors}")
                require(not unexpected_requests, f"Unexpected external request attempts: {unexpected_requests}")
                require(page.evaluate("window.__p1BlockedSockets.length === 0"), "Client attempted unexpected WebSocket network access")
                passed("no JavaScript errors or production/Firebase/payment/WebSocket network attempts")
            finally:
                if context is not None:
                    context.close()
                if browser is not None:
                    browser.close()
        print(f"P1 browser cases: {cases} passed / 0 failed / 0 skipped", flush=True)
    finally:
        server.shutdown()
        server.server_close()
        server_thread.join(timeout=5)


if __name__ == "__main__":
    try:
        run()
    except Exception as error:
        print(f"FAIL P1 browser: {error}", file=sys.stderr, flush=True)
        print("P1 browser result: failed / 0 skipped", file=sys.stderr, flush=True)
        sys.exit(1)
