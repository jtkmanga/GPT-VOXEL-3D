#!/usr/bin/env python3
"""Real generated staging client / Three.js / gameLoop with the actual local Worker.

All browser requests are intercepted. The Firebase identity and initial server
spawn are explicit synthetic fixtures, but keyboard controls, frame prediction,
WebSocket MOVE/COLLECT, SQLite authority, ACK reconciliation and rendering run
the real application. This never contacts a deployed Worker or Firebase service.
"""
import json
from pathlib import Path
import subprocess
import sys
from urllib.parse import urlsplit

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
BRIDGE = ROOT / 'tests/rebuild/staging-gameplay-bridge.cjs'
THREE = ROOT / 'node_modules/three/build/three.min.js'
ORIGIN = 'https://gpt-voxel-3d-staging-gameplay-fixture.invalid'
NOW = 1_900_000_000_000

FIXTURE = r"""
(() => {
  let elapsed = 0, frameCounter = 0;
  const frameCallbacks = new Map();
  const NativeDate = Date;
  window.Date = class SyntheticDate extends NativeDate {
    constructor(...args) { super(...(args.length ? args : [1900000000000 + elapsed])); }
    static now() { return 1900000000000 + elapsed; }
  };
  Object.defineProperty(performance, 'now', { configurable: true, value: () => elapsed });
  window.requestAnimationFrame = callback => { const id = ++frameCounter; frameCallbacks.set(id, callback); return id; };
  window.cancelAnimationFrame = id => frameCallbacks.delete(id);
  const user = { uid: 'synthetic-staging-gameplay-player', displayName: 'Local gameplay player', email: '', photoURL: '',
    async getIdToken() { return 'synthetic-staging-gameplay-browser-token'; } };
  const callbacks = [];
  const auth = { currentUser: null,
    onAuthStateChanged(callback) { callbacks.push(callback); queueMicrotask(() => callback(this.currentUser)); return () => {}; },
    async signInWithPopup() { this.currentUser = user; callbacks.forEach(callback => callback(user)); return { user }; },
    async signOut() { this.currentUser = null; callbacks.forEach(callback => callback(null)); } };
  function authFactory() { return auth; }
  authFactory.GoogleAuthProvider = class SyntheticGoogleProvider {};
  const calls = { database: 0, sockets: new Map(), packets: [], errors: [], corrections: [],
    pending: Promise.resolve(), withheld: [], hold: false, fixture: null, frames: [] };
  window.firebase = { initializeApp() {}, auth: authFactory,
    database() { calls.database++; throw Error('Direct Firebase gameplay data is forbidden'); } };
  function deliver(packets) {
    for (const item of packets || []) {
      const socket = calls.sockets.get(item.id);
      if (socket?.readyState === 1) socket.onmessage?.({ data: JSON.stringify(item.message) });
    }
  }
  function enqueue(operation) {
    calls.pending = calls.pending.then(async () => {
      const response = await window.__gameplayBridge(operation);
      if (calls.hold) calls.withheld.push(...(response.packets || []));
      else deliver(response.packets);
      return response;
    }).catch(error => { calls.errors.push(error.message); throw error; });
    return calls.pending;
  }
  class LocalSocket {
    static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
    constructor(url) {
      this.url = String(url); this.readyState = 0;
      enqueue({ op: 'open', url: this.url, now: Date.now() }).then(response => {
        this.id = response.id; calls.fixture = response.fixture; calls.sockets.set(this.id, this);
        this.readyState = 1; this.onopen?.();
      });
    }
    send(raw) {
      if (this.readyState !== 1) throw Error('Closed offline socket');
      const packet = JSON.parse(raw);
      calls.packets.push(packet);
      enqueue({ op: 'send', id: this.id, packet, now: Date.now() });
    }
    close(code = 1000) { this.readyState = 3; this.onclose?.({ code }); }
  }
  window.WebSocket = LocalSocket;
  calls.flush = async () => {
    for (let i = 0; i < 20; i++) {
      const previous = calls.pending; await previous; await Promise.resolve();
      if (previous === calls.pending) return;
    }
    throw Error('Transport failed to settle');
  };
  calls.step = async (milliseconds = 1000 / 60) => {
    await calls.flush();
    elapsed += milliseconds;
    const response = await window.__gameplayBridge({ op: 'advance', now: Date.now() });
    deliver(response.packets);
    const callbacks = [...frameCallbacks.values()]; frameCallbacks.clear();
    callbacks.forEach(callback => callback(elapsed));
    await calls.flush();
    calls.frames.push({ x: playerPos.x, y: playerPos.y, z: playerPos.z,
      renderedX: playerGroup.position.x, renderedZ: playerGroup.position.z, score: state.score });
  };
  calls.release = async () => { calls.hold = false; deliver(calls.withheld); calls.withheld.length = 0; await calls.flush(); };
  window.__gameplay = calls;
})();
"""


def require(condition, message):
    if not condition:
        raise AssertionError(message)


class Bridge:
    def __init__(self):
        self.process = subprocess.Popen(['node', str(BRIDGE)], cwd=ROOT, stdin=subprocess.PIPE,
                                        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1)
        first = self.process.stdout.readline()
        require(bool(first), 'Offline Worker failed to initialize')
        self.fixture = json.loads(first)['fixture']

    def request(self, value):
        self.process.stdin.write(json.dumps(value) + '\n')
        self.process.stdin.flush()
        line = self.process.stdout.readline()
        require(bool(line), 'Offline Worker transport stopped')
        result = json.loads(line)
        require(result.get('ok'), result.get('error', 'Offline Worker transport failed'))
        return result['result']

    def close(self):
        if self.process.poll() is None:
            self.process.stdin.close()
            self.process.wait(timeout=20)
        require(self.process.returncode == 0, 'Offline Worker exited unsuccessfully')


def run():
    require(THREE.is_file(), 'Pinned Three.js is missing')
    html = subprocess.run(['node', str(BRIDGE), '--build'], cwd=ROOT, text=True,
                          capture_output=True, check=True).stdout
    bridge = Bridge()
    errors, unexpected, dialogs = [], [], []
    cases = 0

    def passed(label):
        nonlocal cases
        cases += 1
        print('PASS staging gameplay browser: ' + label, flush=True)

    def route_request(route):
        parsed = urlsplit(route.request.url)
        if parsed.hostname == urlsplit(ORIGIN).hostname:
            if parsed.path in ('/', '/index.html'):
                route.fulfill(status=200, content_type='text/html', body=html)
                return
            if parsed.path == '/entitlements':
                require(route.request.headers.get('authorization') == 'Bearer synthetic-staging-gameplay-browser-token',
                        'Entitlement request bypassed synthetic SDK identity')
                route.fulfill(status=200, content_type='application/json', body=json.dumps({
                    'ok': True, 'entitlements': {}, 'serverNow': NOW, 'servers': {}}))
                return
        if parsed.hostname == 'cdnjs.cloudflare.com' and parsed.path == '/ajax/libs/three.js/r128/three.min.js':
            route.fulfill(content_type='application/javascript', body=THREE.read_bytes())
            return
        if parsed.hostname == 'cdn.tailwindcss.com' or parsed.hostname == 'www.gstatic.com' and parsed.path.startswith('/firebasejs/10.8.0/'):
            route.fulfill(content_type='application/javascript', body='/* local offline fixture */')
            return
        if parsed.hostname == 'fonts.googleapis.com' or parsed.hostname == 'cdnjs.cloudflare.com' and parsed.path.endswith('/all.min.css'):
            route.fulfill(content_type='text/css', body='/* local offline fixture */')
            return
        if parsed.hostname == 'ui-avatars.com' and parsed.path == '/api/':
            route.fulfill(content_type='image/svg+xml', body='<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>')
            return
        unexpected.append(f'{parsed.scheme}://{parsed.hostname}{parsed.path}')
        route.abort('blockedbyclient')

    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(executable_path='/usr/bin/chromium', headless=True,
                args=['--no-sandbox', '--disable-dev-shm-usage', '--enable-webgl', '--use-gl=angle',
                      '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-background-networking',
                      '--disable-component-update', '--disable-sync', '--no-first-run', '--host-resolver-rules=MAP * ~NOTFOUND'])
            context = browser.new_context(viewport={'width': 800, 'height': 600}, service_workers='block')
            context.set_default_timeout(45_000)
            context.route('**/*', route_request)
            context.add_init_script(FIXTURE)
            context.expose_binding('__gameplayBridge', lambda source, value: bridge.request(value))
            page = context.new_page()
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.on('dialog', lambda dialog: (dialogs.append(dialog.message), dialog.dismiss()))
            try:
                page.goto(ORIGIN, wait_until='load')
                page.wait_for_function('typeof renderer !== "undefined" && !!renderer && typeof stagingResumeForeground === "function"')
                require(page.evaluate('THREE.REVISION === "128" && renderer instanceof THREE.WebGLRenderer && !renderer.getContext().isContextLost()'),
                        'Real Three.js renderer failed')
                page.evaluate('loginWithGoogle()')
                page.wait_for_function('state.isLoggedIn && !!auth.currentUser')
                page.evaluate('(spawn) => playerPos.set(spawn.x, spawn.y, spawn.z)', bridge.fixture['spawn'])
                page.evaluate('selectFreeServer("free1"); startGame()')
                page.wait_for_function('state.isPlaying && secureGameReady && !!secureGameSocket')
                page.evaluate('''() => {
                  const reconcile = secureReconcileMovement;
                  secureReconcileMovement = function(message) {
                    const before = playerPos.clone(); const result = reconcile(message);
                    if(result) __gameplay.corrections.push(before.distanceTo(playerPos));
                    return result;
                  };
                }''')
                page.evaluate('__gameplay.flush()')
                fixture = bridge.fixture
                require(page.evaluate('Math.abs(playerPos.x - __gameplay.fixture.spawn.x) < 1e-9 && coins.length === 200'),
                        'Trusted initial fixture or 200 rendered coins mismatch')
                coin_id = fixture['coin']['id']
                require(page.evaluate(f'coins[{coin_id}].serverId === {coin_id} && coins[{coin_id}].mesh.position.x === __gameplay.fixture.coin.x && coins[{coin_id}].mesh.position.z === __gameplay.fixture.coin.z'),
                        'Rendered/server coin ID or coordinate mismatch')
                passed('generated staging client loads real WebGL and authenticates through actual Worker/ZoneRoom')

                # A real keyboard event drives the normal gameLoop. The player
                # begins eight world units away; no pickup-contact teleport occurs.
                page.keyboard.down('d')
                page.evaluate('''async () => { for(let i=0;i<48;i++) await __gameplay.step(); }''')
                page.keyboard.up('d')
                page.evaluate('''async () => { for(let i=0;i<20;i++) await __gameplay.step(); }''')
                state = bridge.request({'op': 'state'})
                require(state['score'] == 1 and page.evaluate('state.score === 1'), 'Walking through actual coin failed authoritative pickup')
                require(not state['closed'], 'Normal movement unexpectedly closed actual ZoneRoom socket')
                moves = page.evaluate('__gameplay.packets.filter(p => p.type === "move")')
                require(len(moves) >= 5 and all(isinstance(p.get('frames'), list) for p in moves),
                        'Normal frame prediction did not send ordered movement history')
                samples = page.evaluate('__gameplay.frames')
                require(all(samples[i]['x'] >= samples[i-1]['x'] - 1e-7 for i in range(1, 48)), 'Forward walking rubber-banded backwards')
                require(max(abs(s['y']) for s in samples) < 1e-8, 'Ground walking jumped vertically')
                require(max(page.evaluate('__gameplay.corrections'), default=0) < 1e-6, 'Normal authoritative ACK repeatedly corrected frame history')
                require(abs(state['player']['x'] - samples[-1]['x']) < .1, 'Server/player prediction position diverged')
                passed('normal keyboard walking is smooth through real frame history, authoritative ACK and rendering')

                coin = state['coins'][coin_id]
                require(coin['respawnAt'] > state['now'] and not page.evaluate(f'coins[{coin_id}].active || coins[{coin_id}].mesh.visible'),
                        'Confirmed coin was not removed from actual browser')
                collected = [p for p in state['observer'] if p['type'] == 'coin_collected' and p.get('id') == coin_id]
                require(len(collected) == 1, 'Concurrent actual ZoneRoom observer missed shared removal')
                require(collected[0]['respawnAt'] - collected[0]['serverNow'] == 60_000,
                        'Authoritative coin cooldown is not exactly 60 seconds')
                collect_packets = page.evaluate(f'__gameplay.packets.filter(p => p.type === "collect" && p.id === {coin_id}).length')
                require(collect_packets >= 1, 'Rendered pickup never reached actual socket transport')
                require(len(state['coins']) == 200, 'Authoritative map exceeded or lost coin inventory')
                passed('real coin contact atomically awards once and broadcasts shared removal to another player')

                # Hold ACK delivery while frames remain in flight, then change
                # normal controls. Authority applies each interval in order.
                page.evaluate('__gameplay.hold = true')
                page.keyboard.down('a')
                page.evaluate('''async () => { for(let i=0;i<6;i++) await __gameplay.step(); }''')
                page.keyboard.up('a')
                page.keyboard.down('d')
                page.evaluate('''async () => { for(let i=0;i<6;i++) await __gameplay.step(); }''')
                page.keyboard.up('d')
                page.evaluate('__gameplay.release()')
                page.evaluate('''async () => { for(let i=0;i<18;i++) await __gameplay.step(); }''')
                require(max(page.evaluate('__gameplay.corrections'), default=0) < 1e-6, 'Delayed ACK/direction change caused rubber-banding')
                require(page.evaluate('state.score === 1'), 'Direction changes awarded duplicate coin')
                passed('delayed authoritative ACK and opposite input transitions preserve prediction without teleporting')

                # Coins project the exact authoritative cooldown timestamp; a
                # fresh welcome must agree when the 60-second boundary arrives.
                current = bridge.request({'op': 'state'})
                remaining = coin['respawnAt'] - current['now']
                require(remaining > 1, 'Coin cooldown unexpectedly elapsed')
                page.evaluate(f'__gameplay.step({remaining - 1})')
                require(not page.evaluate(f'coins[{coin_id}].active || coins[{coin_id}].mesh.visible'), 'Coin respawned before 60 seconds')
                page.evaluate('__gameplay.step(1)')
                final = bridge.request({'op': 'state'})
                require(page.evaluate(f'coins[{coin_id}].active && coins[{coin_id}].mesh.visible'), 'Coin failed exactly 60-second respawn')
                require(final['coins'][coin_id]['respawnAt'] == final['now'] and final['coins'][coin_id]['cycle'] == coin['cycle'],
                        'Authoritative cooldown/cycle changed unexpectedly')
                late = bridge.request({'op': 'snapshotObserver'})['welcome']['coins'][coin_id]
                require(late['respawnAt'] == final['now'] and late['x'] == final['coins'][coin_id]['x'] and late['z'] == final['coins'][coin_id]['z'],
                        'Fresh authoritative observer disagrees with 60-second respawn or coordinates')
                require(len(final['coins']) == 200 and page.evaluate('coins.length === 200') and final['score'] == 1,
                        'Cooldown changed max coin count or duplicated score')
                passed('browser and fresh authoritative observer agree on exact 60-second respawn with 200 map coins')

                require(not errors and not dialogs and not unexpected and not page.evaluate('__gameplay.errors.length'),
                        f'Browser/fixture errors: {errors}; dialogs: {dialogs}; request paths: {unexpected}')
                require(not final['unexpectedFetches'] and page.evaluate('__gameplay.database === 0'),
                        'Fixture contacted unrelated services or Firebase gameplay data')
                require(page.evaluate('__gameplay.sockets.size === 1') and not final['closed'],
                        'Gameplay unexpectedly reconnected or lost authority')
                require(all(r['name'].startswith(('free-',)) for r in final['routes']), 'Transport reached a non-Free authority')
                passed('zero external requests, reconnects, browser errors or unrelated authority access')
            finally:
                context.close()
                browser.close()
    finally:
        bridge.close()
    print(f'Staging gameplay browser: {cases} passed / 0 failed / 0 skipped', flush=True)


if __name__ == '__main__':
    try:
        run()
    except Exception as error:
        # This fixture contains only synthetic identity material. Keep output
        # to assertion labels rather than transport/browser packet contents.
        print(f'FAIL staging gameplay browser: {error}', file=sys.stderr, flush=True)
        sys.exit(1)
