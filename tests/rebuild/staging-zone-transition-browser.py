#!/usr/bin/env python3
"""Actual generated staging client and actual DO authority across zone boundaries.

Real Chromium/Three.js/gameLoop runs with keyboard controls. Synthetic, ordered
transport latency is independent of the frame clock, so target RPC delays never
stop the test's renderer. All browser I/O is intercepted; no live service is used.
"""
import json
import os
import select
from pathlib import Path
import subprocess
import sys
import time
from urllib.parse import urlsplit

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
BRIDGE = ROOT / 'tests/rebuild/staging-zone-transition-bridge.cjs'
THREE = ROOT / 'node_modules/three/build/three.min.js'
ORIGIN = 'https://gpt-voxel-3d-staging-zone-fixture.invalid'
NOW = 1_900_000_000_000

FIXTURE = r"""
(() => {
  let elapsed = 0, timerId = 0, frameId = 0;
  const timers = new Map(), frames = new Map();
  const NativeDate = Date;
  const nativeTimeout = window.setTimeout.bind(window), nativeClearTimeout = window.clearTimeout.bind(window);
  window.Date = class SyntheticDate extends NativeDate {
    constructor(...args) { super(...(args.length ? args : [1900000000000 + elapsed])); }
    static now() { return 1900000000000 + elapsed; }
  };
  Object.defineProperty(performance, 'now', { configurable: true, value: () => elapsed });
  function timer(callback, delay, repeat = 0) {
    const id = ++timerId; timers.set(id, { callback, due: elapsed + Math.max(0, Number(delay) || 0), repeat }); return id;
  }
  window.setTimeout = (callback, delay, ...args) => timer(() => callback(...args), delay);
  window.clearTimeout = id => timers.delete(id);
  window.setInterval = (callback, delay, ...args) => timer(() => callback(...args), delay, Math.max(1, Number(delay) || 1));
  window.clearInterval = id => timers.delete(id);
  window.requestAnimationFrame = callback => { const id = ++frameId; frames.set(id, callback); return id; };
  window.cancelAnimationFrame = id => frames.delete(id);
  const user = { uid: 'synthetic-staging-zone-player', displayName: 'Local zone player', email: '', photoURL: '',
    async getIdToken() { return 'synthetic-staging-zone-browser-token'; } };
  const callbacks = [];
  const auth = { currentUser: null,
    onAuthStateChanged(callback) { callbacks.push(callback); queueMicrotask(() => callback(this.currentUser)); return () => {}; },
    async signInWithPopup() { this.currentUser = user; callbacks.forEach(callback => callback(user)); return { user }; },
    async signOut() { this.currentUser = null; callbacks.forEach(callback => callback(null)); } };
  function authFactory() { return auth; }
  authFactory.GoogleAuthProvider = class SyntheticGoogleProvider {};
  const calls = { database: 0, sockets: new Map(), packets: [], received: [], errors: [], corrections: [], correctionEvents: [],
    pending: Promise.resolve(), samples: [], memberships: [], delays: { open: 1000, welcome: 500, resumeSend: 500, ack: 0 }, fixture: null };
  window.firebase = { initializeApp() {}, auth: authFactory,
    database() { calls.database++; throw Error('Direct Firebase gameplay data forbidden'); } };
  function deliver(event) {
    const socket = calls.sockets.get(event.id);
    if (!socket || socket.readyState === 3) return;
    if (event.kind === 'close') { socket.readyState = 3; socket.onclose?.({ code: event.code }); return; }
    calls.received.push({ id: event.id, now: Date.now(), message: event.message });
    socket.onmessage?.({ data: JSON.stringify(event.message) });
  }
  function accept(response) {
    if (response.membership) calls.memberships.push(response.membership);
    for (const event of response.events || []) {
      const socket = calls.sockets.get(event.id);
      const message = event.message;
      const delay = socket?.transition && message?.type === 'welcome' ? calls.delays.welcome
        : message?.type === 'handoff_resumed' ? calls.delays.ack : 0;
      if (delay) timer(() => deliver(event), delay); else deliver(event);
    }
  }
  function enqueue(command) {
    calls.pending = calls.pending.then(async () => {
      const response = await window.__zoneBridge({ ...command, now: Date.now() });
      accept(response); return response;
    }).catch(error => { calls.errors.push(error.message); throw error; });
    return calls.pending;
  }
  class LocalSocket {
    static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
    constructor(url) {
      this.url = String(url); this.readyState = 0; this.transition = calls.sockets.size > 0;
      enqueue({ op: 'open', url: this.url }).then(response => {
        this.id = response.id; calls.sockets.set(this.id, this);
        const open = () => { if(this.readyState !== 0) return; this.readyState = 1; this.onopen?.(); };
        if(this.transition && calls.delays.open) timer(open, calls.delays.open); else open();
      });
    }
    send(raw) {
      if (this.readyState !== 1) throw Error('Closed offline zone socket');
      const packet = JSON.parse(raw);
      calls.packets.push({ id: this.id, now: Date.now(), packet });
      const send = () => { if(this.readyState === 1) enqueue({ op: 'send', id: this.id, packet }); };
      if(packet.type === 'handoff_resume' && calls.delays.resumeSend) timer(send, calls.delays.resumeSend); else send();
    }
    close(code = 1000) {
      if(this.readyState === 3) return;
      this.readyState = 3; enqueue({ op: 'close', id: this.id, code }); this.onclose?.({ code });
    }
  }
  window.WebSocket = LocalSocket;
  calls.flush = async () => {
    for(let i=0;i<100;i++) {
      const before = calls.pending;
      let deadline;
      try {
        await Promise.race([before, new Promise((_, reject) => {
          deadline = nativeTimeout(() => reject(Error('Offline client transport exceeded 15-second flush deadline')), 15000);
        })]);
      } finally { nativeClearTimeout(deadline); }
      for(let j=0;j<12;j++) await Promise.resolve();
      if(before === calls.pending) return;
    }
    throw Error('Offline zone transport did not settle');
  };
  calls.step = async (milliseconds = 1000 / 60) => {
    await calls.flush(); elapsed += milliseconds;
    accept(await window.__zoneBridge({ op: 'advance', now: Date.now() }));
    for(let rounds=0;rounds<100;rounds++) {
      const due = [...timers].filter(([,t]) => t.due <= elapsed).sort((a,b) => a[1].due-b[1].due);
      if(!due.length) break;
      for(const [id,t] of due) {
        if(!timers.has(id)) continue;
        if(t.repeat) t.due += t.repeat; else timers.delete(id);
        t.callback();
      }
      await calls.flush();
    }
    const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback(elapsed));
    await calls.flush();
    calls.samples.push({ now: Date.now(), x: playerPos.x, y: playerPos.y, z: playerPos.z,
      vx: playerVel.x, vz: playerVel.z, vy: playerVelocityY,
      renderedX: playerGroup.position.x, renderedY: playerGroup.position.y, renderedZ: playerGroup.position.z,
      jumpHeld: secureJumpHeld, jumpIntent: secureJumpIntent,
      zone: secureCurrentZoneId, pending: secureHandoffInProgress, score: state.score,
      queuedFrames: securePendingFrames.length, keys: { ...keys } });
  };
  calls.steps = async count => { for(let i=0;i<count;i++) await calls.step(); };
  window.__zone = calls;
})();
"""


def require(condition, message):
    if not condition:
        raise AssertionError(message)


class Bridge:
    def __init__(self, near_border=False):
        args = ['node', str(BRIDGE)] + (['--near-border'] if near_border else [])
        self.process = subprocess.Popen(args, cwd=ROOT, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        stderr=subprocess.PIPE, bufsize=0)
        self.timed_out = False
        self.rpc_latencies = []
        self.stdout_buffer = bytearray()
        first = self.read_line({'op': 'initialize'})
        require(bool(first), 'Offline zone Worker failed to initialize')
        self.fixture = json.loads(first)['fixture']

    def read_line(self, command):
        deadline = time.perf_counter() + 10
        while True:
            newline = self.stdout_buffer.find(b'\n')
            if newline >= 0:
                result = bytes(self.stdout_buffer[:newline])
                del self.stdout_buffer[:newline+1]
                return result
            remaining = deadline - time.perf_counter()
            readable, _, _ = select.select([self.process.stdout], [], [], max(0, remaining))
            if not readable or remaining <= 0:
                self.timed_out = True
                packet = command.get('packet', {})
                raise AssertionError(f"Offline zone authority exceeded 10-second command deadline: {command.get('op')} {packet.get('type', '')} socket {command.get('id', '')}")
            chunk = os.read(self.process.stdout.fileno(), 65536)
            require(bool(chunk), 'Offline zone Worker transport stopped before a complete response')
            self.stdout_buffer.extend(chunk)

    def request(self, value):
        started = time.perf_counter()
        self.process.stdin.write((json.dumps(value) + '\n').encode()); self.process.stdin.flush()
        response = json.loads(self.read_line(value))
        require(response.get('ok'), response.get('error', 'Offline zone Worker failed'))
        self.rpc_latencies.append({'operation': value.get('op'),
            'message': value.get('packet', {}).get('type'), 'milliseconds': (time.perf_counter()-started)*1000})
        return response['result']

    def close(self):
        if self.process.poll() is None:
            if self.timed_out:
                self.process.terminate(); self.process.wait(timeout=10)
            else:
                self.process.stdin.close(); self.process.wait(timeout=20)
        if not self.timed_out:
            require(self.process.returncode == 0, 'Offline zone Worker exited unsuccessfully')


def route_factory(html, unexpected):
    def route_request(route):
        parsed = urlsplit(route.request.url)
        if parsed.hostname == urlsplit(ORIGIN).hostname:
            if parsed.path in ('/', '/index.html'):
                route.fulfill(status=200, content_type='text/html', body=html); return
            if parsed.path == '/entitlements':
                require(route.request.headers.get('authorization') == 'Bearer synthetic-staging-zone-browser-token', 'Entitlements bypassed SDK identity')
                route.fulfill(status=200, content_type='application/json', body=json.dumps({
                    'ok': True, 'entitlements': {}, 'serverNow': NOW, 'servers': {}})); return
        if parsed.hostname == 'cdnjs.cloudflare.com' and parsed.path == '/ajax/libs/three.js/r128/three.min.js':
            route.fulfill(content_type='application/javascript', body=THREE.read_bytes()); return
        if parsed.hostname == 'cdn.tailwindcss.com' or parsed.hostname == 'www.gstatic.com' and parsed.path.startswith('/firebasejs/10.8.0/'):
            route.fulfill(content_type='application/javascript', body='/* offline fixture */'); return
        if parsed.hostname == 'fonts.googleapis.com' or parsed.hostname == 'cdnjs.cloudflare.com' and parsed.path.endswith('/all.min.css'):
            route.fulfill(content_type='text/css', body='/* offline fixture */'); return
        if parsed.hostname == 'ui-avatars.com' and parsed.path == '/api/':
            route.fulfill(content_type='image/svg+xml', body='<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>'); return
        unexpected.append(f'{parsed.scheme}://{parsed.hostname}{parsed.path}'); route.abort('blockedbyclient')
    return route_request


def start_case(browser, html, near_border=False, delays=None):
    bridge = Bridge(near_border)
    errors, dialogs, unexpected = [], [], []
    context = browser.new_context(viewport={'width': 800, 'height': 600}, service_workers='block')
    context.set_default_timeout(45_000)
    context.route('**/*', route_factory(html, unexpected))
    context.add_init_script(FIXTURE)
    context.expose_binding('__zoneBridge', lambda source, value: bridge.request(value))
    page = context.new_page()
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.on('dialog', lambda dialog: (dialogs.append(dialog.message), dialog.dismiss()))
    try:
        page.goto(ORIGIN, wait_until='load')
        page.wait_for_function('typeof renderer !== "undefined" && !!renderer && typeof stagingResumeForeground === "function"')
        require(page.evaluate('THREE.REVISION === "128" && renderer instanceof THREE.WebGLRenderer && !renderer.getContext().isContextLost()'), 'Real Three.js/WebGL failed')
        if delays:
            page.evaluate('(delays) => Object.assign(__zone.delays, delays)', delays)
        page.evaluate('(fixture) => { __zone.fixture=fixture; playerPos.set(fixture.spawn.x, fixture.spawn.y, fixture.spawn.z); }', bridge.fixture)
        page.evaluate('loginWithGoogle()')
        page.wait_for_function('state.isLoggedIn && !!auth.currentUser')
        page.evaluate('selectFreeServer("free1"); startGame()')
        page.wait_for_function('state.isPlaying && secureGameReady && !!secureGameSocket')
        page.evaluate('''() => {
          const reconcile = secureReconcileMovement;
          secureReconcileMovement = function(message) {
            const before = playerPos.clone(); const result = reconcile(message);
            if(result) {
              const distance=before.distanceTo(playerPos);
              __zone.corrections.push(distance);
              if(distance>.25) __zone.correctionEvents.push({ distance, now: Date.now(), message,
                before: {x:before.x,y:before.y,z:before.z}, after: {x:playerPos.x,y:playerPos.y,z:playerPos.z},
                pendingFrames: securePendingFrames.map(f=>({seq:f.seq,delta:f.delta,input:f.input})),
                pending: secureHandoffInProgress, sequence: secureInputSequence,
                operation:secureActiveHandoff&&{continuous:secureActiveHandoff.continuous,sealed:secureActiveHandoff.sealed,confirmed:secureActiveHandoff.confirmed} });
            }
            return result;
          };
        }''')
        page.evaluate('__zone.flush()')
        return context, page, bridge, errors, dialogs, unexpected
    except Exception:
        context.close(); bridge.close(); raise


def finish_case(case):
    context, page, bridge, errors, dialogs, unexpected = case
    try:
        state = bridge.request({'op': 'state'})
        require(not errors and not dialogs and not unexpected and not page.evaluate('__zone.errors.length'),
                f'Browser/transport errors: {errors}; dialogs: {dialogs}; paths: {unexpected}')
        require(not state['unexpectedFetches'] and page.evaluate('__zone.database === 0'), 'Unrelated external authority access')
        require(page.evaluate('state.isPlaying && secureGameReady && !secureHandoffInProgress'), 'Handoff did not settle into live game')
        active = [s for s in state['membershipHistory'] if s['owner']]
        require(active and all(len(s['members']) == 1 for s in active), 'Boundary transfer had duplicate or missing active membership')
        require(all(s['owner'] == 'zone:' + s['members'][0]['zone'] for s in active), 'Active zone diverged from durable session owner')
        ids = {s['members'][0]['id'] for s in active}
        require(len(ids) == 1 and page.evaluate('state.serverPlayerId') in ids, 'Boundary changed stable player identity')
        sequences = [s['members'][0]['motion']['seq'] for s in active]
        require(all(sequences[i] >= sequences[i-1] for i in range(1, len(sequences))),
                'Boundary reset or replayed authoritative movement sequence')
        require(max(page.evaluate('__zone.corrections'), default=0) < .25, 'Boundary caused excessive authoritative position correction')
        server = active[-1]['members'][0]
        require(page.evaluate('''(server) => Math.hypot(playerPos.x-server.x, playerPos.y-server.y, playerPos.z-server.z) < .25''', server),
                'Settled browser and current authoritative position diverged')
        return state
    finally:
        context.close(); bridge.close()


def run():
    require(THREE.is_file(), 'Pinned local Three.js is missing')
    html = subprocess.run(['node', str(BRIDGE), '--build'], cwd=ROOT, text=True, capture_output=True, check=True).stdout
    cases = 0

    def passed(label):
        nonlocal cases
        cases += 1; print('PASS staging zone browser: ' + label, flush=True)

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path='/usr/bin/chromium', headless=True,
            args=['--no-sandbox', '--disable-dev-shm-usage', '--enable-webgl', '--use-gl=angle', '--use-angle=swiftshader',
                  '--enable-unsafe-swiftshader', '--disable-background-networking', '--disable-component-update',
                  '--disable-sync', '--no-first-run', '--host-resolver-rules=MAP * ~NOTFOUND'])
        try:
            # Delay target connection/authentication/resume by two simulated
            # seconds while actual source packets and rendering keep advancing.
            case = start_case(browser, html)
            _, page, bridge, _, _, _ = case
            try:
                page.keyboard.down('d'); page.evaluate('__zone.steps(240)'); page.keyboard.up('d')
                page.evaluate('__zone.steps(24)')
                samples = page.evaluate('__zone.samples')
                pending = [s for s in samples if s['pending'] and s['keys']['d']]
                require(len(pending) >= 90, 'Latency fixture did not exercise two-second target warmup')
                for i in range(15, 240):
                    require(samples[i]['x'] > samples[i-1]['x'] + .1,
                            f"Continuous forward motion froze or snapped at zone boundary (frame {i}, delta {samples[i]['x'] - samples[i-1]['x']:.6f}, pending {samples[i]['pending']})")
                    require(samples[i]['renderedX'] > samples[i-1]['renderedX'] + .05,
                            f"Rendered player froze at zone boundary (frame {i})")
                    require(samples[i]['x'] - samples[i-1]['x'] < .75, 'Boundary teleported forward')
                require(max(abs(s['y']) for s in samples) < 1e-8, 'Ground crossing caused vertical jump')
                require(page.evaluate('secureCurrentZoneId') == bridge.fixture['targetZone'], 'Forward crossing failed target ownership')
                received = page.evaluate('__zone.received')
                changes = [e for e in received if e['message']['type'] == 'zone_change']
                resumed = [e for e in received if e['message']['type'] == 'handoff_resumed']
                require(len(changes) == len(resumed) == 1, 'Forward crossing failed a single complete handoff')
                handoff_ms = resumed[0]['now'] - changes[0]['now']
                require(handoff_ms >= 1950, 'Measured target latency did not exercise the reported multi-second delay')
                longest_pause = 0
                pause = 0
                for i in range(15, 240):
                    pause = pause + samples[i]['now'] - samples[i-1]['now'] if samples[i]['renderedX'] <= samples[i-1]['renderedX'] else 0
                    longest_pause = max(longest_pause, pause)
                commit_times = [entry['milliseconds'] for entry in bridge.rpc_latencies if entry['message'] == 'handoff_resume']
                require(len(commit_times) == 1 and commit_times[0] < 1000, 'Serialized authoritative cutover exceeded one-second local RPC budget')
                state = finish_case(case); case = None
                require(state['socketCount'] == 2, 'One crossing created repeated or unnecessary sockets')
                passed(f'continuous keyboard walking/rendering stays smooth with target handoff {handoff_ms:.1f} ms; movement pause {longest_pause:.1f} ms; authoritative cutover {commit_times[0]:.1f} ms; exactly one owner')
            finally:
                if case:
                    case[0].close(); case[2].close()

            # Turns while the target is warming, then two reverse crossings.
            case = start_case(browser, html)
            _, page, bridge, _, _, _ = case
            try:
                page.keyboard.down('d')
                page.evaluate('''async () => { for(let i=0;i<130 && !secureHandoffInProgress;i++) await __zone.step(); }''')
                require(page.evaluate('secureHandoffInProgress'), 'Turn scenario never reached a boundary')
                page.keyboard.down('s'); page.evaluate('__zone.steps(12)'); page.keyboard.up('s')
                page.evaluate('__zone.steps(156)'); page.keyboard.up('d')
                require(page.evaluate('secureCurrentZoneId') == bridge.fixture['targetZone'], 'Turn during warmup lost target zone')
                page.keyboard.down('a'); page.evaluate('__zone.steps(300)'); page.keyboard.up('a')
                page.evaluate('__zone.steps(24)')
                require(page.evaluate('secureCurrentZoneId') == bridge.fixture['sourceZone'], 'Reverse crossing failed to return to source')
                page.keyboard.down('d'); page.evaluate('__zone.steps(300)'); page.keyboard.up('d')
                page.evaluate('__zone.steps(24)')
                require(page.evaluate('secureCurrentZoneId') == bridge.fixture['targetZone'], 'Repeated forward crossing failed')
                samples = page.evaluate('__zone.samples')
                require(any(s['keys']['s'] and s['pending'] and s['vz'] > 5 for s in samples), 'Turning input was lost while handoff pending')
                require(all(abs(samples[i]['x'] - samples[i-1]['x']) < 1 for i in range(1, len(samples))), 'Reverse crossing teleported')
                state = finish_case(case); case = None
                require(state['socketCount'] == 4, 'Three crossings caused missing transfers or unexpected reconnects')
                passed('turning input and repeated back-and-forth crossings retain stable identity, single ownership and continuity')
            finally:
                if case:
                    case[0].close(); case[2].close()

            # Reverse repeatedly before the delayed target is ready. This is
            # distinct from three completed handoffs: a provisional target must
            # cancel/retarget without rolling source authority back to a stale
            # boundary anchor or resetting inputs.
            print('CHECK staging zone browser: rapid provisional reversals', flush=True)
            case = start_case(browser, html, near_border=True)
            _, page, bridge, _, _, _ = case
            try:
                boundary = bridge.fixture['boundary']
                for _ in range(3):
                    page.keyboard.down('d')
                    require(page.evaluate('''async boundary => {
                        for(let i=0;i<120;i++) { await __zone.step(); if(playerPos.x > boundary+3) return true; }
                        return false;
                    }''', boundary), 'Rapid crossing failed forward travel')
                    page.keyboard.up('d'); page.keyboard.down('a')
                    require(page.evaluate('''async boundary => {
                        for(let i=0;i<120;i++) { await __zone.step(); if(playerPos.x < boundary-3) return true; }
                        return false;
                    }''', boundary), 'Rapid crossing lost reverse input')
                    page.keyboard.up('a')
                page.keyboard.down('d'); page.evaluate('__zone.steps(190)'); page.keyboard.up('d')
                page.evaluate('__zone.steps(24)')
                require(page.evaluate('secureCurrentZoneId') == bridge.fixture['targetZone'], 'Rapid crossings failed eventual target ownership')
                samples = page.evaluate('__zone.samples')
                sides = [s['x'] >= boundary for s in samples]
                crossings = sum(sides[i] != sides[i-1] for i in range(1, len(sides)))
                require(crossings >= 7, 'Rapid scenario did not cross the same boundary at least seven times')
                require(any(s['pending'] and s['keys']['a'] and s['vx'] < -10 for s in samples),
                        'Reverse input was discarded during provisional handoff')
                require(all(abs(samples[i]['x']-samples[i-1]['x']) < .75 for i in range(1, len(samples))),
                        'Cancelled or retargeted rapid crossing rolled position back or teleported')
                state = finish_case(case); case = None
                require(state['socketCount'] < 10, 'Rapid crossings caused an unbounded socket/reconnect loop')
                passed('seven rapid boundary crossings during target warmup retain reverse inputs and authority without stale rollback')
            finally:
                if case:
                    case[0].close(); case[2].close()

            # Complete a fast handoff while a normal held jump is airborne.
            case = start_case(browser, html, near_border=True,
                              delays={'open': 40, 'welcome': 40, 'resumeSend': 40, 'ack': 0})
            _, page, bridge, _, _, _ = case
            try:
                page.keyboard.down('d'); page.evaluate('__zone.steps(3)')
                page.keyboard.down('Space'); page.evaluate('__zone.steps(90)')
                page.keyboard.up('Space'); page.keyboard.up('d'); page.evaluate('__zone.steps(24)')
                samples = page.evaluate('__zone.samples')
                require(any(s['pending'] and s['y'] > .5 for s in samples), 'Jump scenario was not airborne at handoff')
                resumed = page.evaluate('__zone.received.filter(e => e.message.type === "handoff_resumed")')
                require(len(resumed) == 1 and resumed[0]['message']['y'] > .5, 'Handoff failed to preserve airborne authoritative position')
                require(max(s['y'] for s in samples) < 3.5, 'Held jump replayed or boosted at handoff')
                require(all(abs(samples[i]['y'] - samples[i-1]['y']) < .4 for i in range(1, len(samples))), 'Airborne handoff snapped height')
                require(all(abs(s['y']) < 1e-8 for s in samples[-20:]), 'Held jump relaunched after landing')
                finish_case(case); case = None
                passed('airborne boundary transfer preserves vertical motion and held-jump state without replay or reset')
            finally:
                if case:
                    case[0].close(); case[2].close()

            # Normal keyboard contact with actual shared coins on both sides;
            # after-border coin is reached while the target is still warming.
            case = start_case(browser, html)
            _, page, bridge, _, _, _ = case
            try:
                page.keyboard.down('d'); page.evaluate('__zone.steps(42)')
                require(page.evaluate('state.score === 1'), 'Before-border real coin was not collected')
                page.keyboard.down('s'); page.evaluate('__zone.steps(30)'); page.keyboard.up('s')
                page.evaluate('__zone.steps(150)'); page.keyboard.up('d'); page.evaluate('__zone.steps(24)')
                fixture = bridge.fixture
                ids = [fixture['before']['id'], fixture['after']['id']]
                require(page.evaluate('state.score === 2'), 'After-border real coin was lost during provisional handoff')
                require(page.evaluate('''(ids) => ids.every(id => __zone.received.some(e =>
                    e.message.type === 'coin_collect_result' && e.message.id === id && e.message.collected))''', ids),
                    'Both pickups did not reach actual authoritative Durable Object')
                require(page.evaluate('''(id) => __zone.samples.some(s => s.pending && s.score === 2)''', ids[1]),
                    'After-border pickup did not occur during delayed warmup')
                state = finish_case(case); case = None
                require(state['score'] == 2 and len(state['coins']) == 200, 'Boundary duplicated score or changed map coin count')
                require(all(state['coins'][id]['respawnAt'] > state['membership']['now'] for id in ids), 'Collected boundary coin lost cooldown')
                passed('actual coins before/after border collect once through current sole authority during warmup with 200 map coins')
            finally:
                if case:
                    case[0].close(); case[2].close()
        finally:
            browser.close()
    print(f'Staging zone browser: {cases} passed / 0 failed / 0 skipped', flush=True)


if __name__ == '__main__':
    try:
        run()
    except Exception as error:
        print(f'FAIL staging zone browser: {error}', file=sys.stderr, flush=True)
        sys.exit(1)
