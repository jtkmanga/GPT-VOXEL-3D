#!/usr/bin/env python3
import argparse, json, math, os, statistics, sys, time, uuid
from pathlib import Path
from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeoutError

ORIGIN = "https://gpt-voxel-3d-staging-01.hjinffv5426.workers.dev"
EXPECTED_HOST = "gpt-voxel-3d-staging-01.hjinffv5426.workers.dev"

def percentile(values, p):
    if not values:
        return None
    xs = sorted(float(v) for v in values)
    i = max(0, min(len(xs)-1, math.ceil(len(xs)*p)-1))
    return round(xs[i], 3)

def page_metric(page):
    return page.evaluate("""() => {
      const s = window.__gate6Canary || {};
      return {
        welcomed: !!s.welcomed,
        welcomeMs: Number.isFinite(s.welcomeMs) ? s.welcomeMs : null,
        ackLatencies: Array.isArray(s.ackLatencies) ? s.ackLatencies.slice() : [],
        movementAcks: Number(s.movementAcks || 0),
        movementRejected: Number(s.movementRejected || 0),
        authErrors: Number(s.authErrors || 0),
        serverErrors: Number(s.serverErrors || 0),
        clientErrors: Number(s.clientErrors || 0),
        unexpectedCloses: Number(s.unexpectedCloses || 0),
        closeCode: Number(s.closeCode || 0),
        playerId: typeof s.playerId === 'string' ? s.playerId : '',
        readyState: s.ws ? s.ws.readyState : -1
      };
    }""")

def start_identity_and_socket(page, index, run_id):
    result = page.evaluate("""async ({index, runId, origin}) => {
      const safeCode = e => String(e?.code || e?.name || 'unknown').slice(0, 80);
      try {
        if (!window.firebase || !firebase.apps || !firebase.apps.length || !firebase.auth) {
          return {ok:false, stage:'firebase-init', code:'firebase-unavailable'};
        }
        if (firebase.appCheck) {
          try {
            const ac = firebase.appCheck();
            if (ac && typeof ac.getToken === 'function') await ac.getToken(true);
          } catch (e) {
            return {ok:false, stage:'app-check', code:safeCode(e)};
          }
        }

        let mode = '';
        try {
          await firebase.auth().signInAnonymously();
          mode = 'anonymous';
        } catch (e) {
          if (safeCode(e) !== 'auth/operation-not-allowed') {
            return {ok:false, stage:'anonymous-auth', code:safeCode(e)};
          }
          const email = 'gate6-' + runId + '-' + index + '@example.invalid';
          const password = 'G6!' + runId + '-' + index + '-TempOnly';
          try {
            await firebase.auth().createUserWithEmailAndPassword(email, password);
            mode = 'temporary-email-password';
          } catch (e2) {
            return {ok:false, stage:'temporary-auth', code:safeCode(e2)};
          }
        }

        const user = firebase.auth().currentUser;
        if (!user) return {ok:false, stage:'temporary-auth', code:'no-current-user'};
        const token = await user.getIdToken(true);
        const zone = String(index % 10) + ',0';
        const wsUrl = origin.replace(/^https:/, 'wss:') + '/play?server=free1&zone=' + encodeURIComponent(zone);
        const state = window.__gate6Canary = {
          mode, ws:null, welcomed:false, welcomeMs:null, startedAt:performance.now(),
          seq:0, pending:{}, ackLatencies:[], movementAcks:0, movementRejected:0,
          authErrors:0, serverErrors:0, clientErrors:0, unexpectedCloses:0,
          closeCode:0, playerId:'', stopRequested:false, timer:null
        };
        const ws = state.ws = new WebSocket(wsUrl);

        return await new Promise(resolve => {
          let settled = false;
          const finish = value => { if (!settled) { settled = true; resolve(value); } };
          const timeout = setTimeout(() => finish({ok:false, stage:'welcome', code:'timeout'}), 15000);

          ws.onopen = () => {
            try {
              ws.send(JSON.stringify({type:'auth', token, protocol:6, name:'Canary' + index}));
            } catch (_) {
              state.clientErrors++;
            }
          };
          ws.onmessage = event => {
            let m;
            try { m = JSON.parse(event.data); }
            catch (_) { state.clientErrors++; return; }

            if (m?.type === 'welcome' && !state.welcomed) {
              state.welcomed = true;
              state.welcomeMs = performance.now() - state.startedAt;
              state.playerId = String(m.id || '');
              state.seq = Number.isInteger(m?.movement?.lastSeq) ? m.movement.lastSeq + 1 : 0;
              const input = {x:0.12,z:0,jump:false};
              state.timer = setInterval(() => {
                if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;
                const seq = state.seq++;
                state.pending[String(seq)] = performance.now();
                try {
                  state.ws.send(JSON.stringify({
                    type:'move', input, seq,
                    frames:[{input:{...input},delta:0.05}]
                  }));
                } catch (_) { state.clientErrors++; }
              }, 1000);
              clearTimeout(timeout);
              finish({ok:true, mode, welcomeMs:state.welcomeMs});
              return;
            }
            if (m?.type === 'move' && Number.isInteger(m.ack)) {
              const key = String(m.ack);
              if (Object.prototype.hasOwnProperty.call(state.pending, key)) {
                state.ackLatencies.push(performance.now() - state.pending[key]);
                delete state.pending[key];
                state.movementAcks++;
              }
              if (m.applied === false) state.movementRejected++;
            } else if (m?.type === 'auth_error') state.authErrors++;
            else if (m?.type === 'server_error') state.serverErrors++;
          };
          ws.onerror = () => { state.clientErrors++; };
          ws.onclose = event => {
            state.closeCode = Number(event.code || 0);
            if (!state.stopRequested) state.unexpectedCloses++;
            if (!state.welcomed) {
              clearTimeout(timeout);
              finish({ok:false, stage:'socket-close', code:'close-' + String(event.code || 0)});
            }
          };
        });
      } catch (e) {
        return {ok:false, stage:'exception', code:safeCode(e)};
      }
    }""", {"index": index, "runId": run_id, "origin": ORIGIN})
    return result

def stop_and_delete(page):
    return page.evaluate("""async () => {
      const s = window.__gate6Canary;
      if (s) {
        s.stopRequested = true;
        if (s.timer) clearInterval(s.timer);
        try { if (s.ws && s.ws.readyState <= WebSocket.OPEN) s.ws.close(1000, 'Gate6 canary complete'); } catch (_) {}
      }
      let deleted = false, code = '';
      try {
        const user = firebase.auth().currentUser;
        if (user) { await user.delete(); deleted = true; }
      } catch (e) { code = String(e?.code || e?.name || 'delete-failed').slice(0, 80); }
      try { await firebase.auth().signOut(); } catch (_) {}
      return {deleted, code};
    }""")

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--levels", default="2,5,10")
    parser.add_argument("--seconds", type=int, default=60)
    parser.add_argument("--out", default="work/gate6/canary.json")
    args = parser.parse_args()
    levels = [int(x) for x in args.levels.split(",")]
    if levels != [2,5,10] or args.seconds != 60:
        raise SystemExit("Gate 6 owner approval is bounded to levels 2,5,10 and 60 seconds per step")

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    report = {
      "formatVersion": 1,
      "mode": "live-staging-authorized-browser-canary",
      "origin": ORIGIN,
      "levels": [],
      "authMode": None,
      "complete": False,
      "stopReason": None,
      "limitations": [
        "Bounded staging canary only: 2 -> 5 -> 10 sessions, 60 seconds per step.",
        "Temporary Firebase users are created only through the public staging client with App Check and deleted after the run.",
        "Passing this canary is not evidence for 10,000 concurrent players or production capacity.",
        "Cloudflare billing is not queried by this workflow; owner evidence established Workers Free with no payment method before approval."
      ]
    }
    pages = []
    contexts = []
    run_id = uuid.uuid4().hex[:10]

    def save():
        out.write_text(json.dumps(report, indent=2, sort_keys=True), encoding="utf-8")

    try:
      with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        try:
          for target in levels:
            while len(pages) < target:
              i = len(pages)
              context = browser.new_context()
              page = context.new_page()
              contexts.append(context)
              pages.append(page)
              page.goto(ORIGIN, wait_until="domcontentloaded", timeout=30000)
              if not page.url.startswith(ORIGIN):
                report["stopReason"] = "non-staging-route"
                save(); return 2
              page.wait_for_function("typeof firebase !== 'undefined' && firebase.apps && firebase.apps.length > 0 && typeof firebase.auth === 'function'", timeout=30000)
              result = start_identity_and_socket(page, i, run_id)
              if not result.get("ok"):
                report["stopReason"] = "authorization-blocker:" + str(result.get("stage")) + ":" + str(result.get("code"))
                save(); return 3
              mode = result.get("mode")
              if report["authMode"] is None: report["authMode"] = mode
              elif report["authMode"] != mode:
                report["stopReason"] = "mixed-temporary-auth-modes"
                save(); return 4

            started = time.monotonic()
            while time.monotonic() - started < args.seconds:
              time.sleep(5)
              metrics = [page_metric(page) for page in pages[:target]]
              unexpected = sum(m["unexpectedCloses"] for m in metrics)
              errors = sum(m["authErrors"] + m["serverErrors"] + m["clientErrors"] for m in metrics)
              rejected = sum(m["movementRejected"] for m in metrics)
              acks = [v for m in metrics for v in m["ackLatencies"]]
              p95 = percentile(acks, .95)
              player_ids = [m["playerId"] for m in metrics if m["playerId"]]
              authority_violation = len(player_ids) != len(set(player_ids)) or rejected > 0
              error_rate = (unexpected + errors) / target
              if authority_violation:
                report["stopReason"] = "authority-state-violation"; save(); return 5
              if error_rate > 0.01:
                report["stopReason"] = "error-or-close-rate-above-1-percent"; save(); return 6
              if len(acks) >= target * 5 and p95 is not None and p95 > 500:
                report["stopReason"] = "movement-ack-p95-above-500ms"; save(); return 7

            metrics = [page_metric(page) for page in pages[:target]]
            acks = [v for m in metrics for v in m["ackLatencies"]]
            welcomes = [m["welcomeMs"] for m in metrics if m["welcomeMs"] is not None]
            unexpected = sum(m["unexpectedCloses"] for m in metrics)
            errors = sum(m["authErrors"] + m["serverErrors"] + m["clientErrors"] for m in metrics)
            rejected = sum(m["movementRejected"] for m in metrics)
            player_ids = [m["playerId"] for m in metrics if m["playerId"]]
            level = {
              "targetSessions": target,
              "activeSessions": sum(1 for m in metrics if m["readyState"] == 1 and m["welcomed"]),
              "welcomeSuccess": sum(1 for m in metrics if m["welcomed"]),
              "welcomeP95Ms": percentile(welcomes, .95),
              "movementAcks": sum(m["movementAcks"] for m in metrics),
              "movementAckP95Ms": percentile(acks, .95),
              "unexpectedCloses": unexpected,
              "authErrors": sum(m["authErrors"] for m in metrics),
              "serverErrors": sum(m["serverErrors"] for m in metrics),
              "clientErrors": sum(m["clientErrors"] for m in metrics),
              "movementRejected": rejected,
              "uniquePlayerIds": len(set(player_ids)),
              "passed": False
            }
            level["passed"] = (
              level["activeSessions"] == target and level["welcomeSuccess"] == target and
              len(player_ids) == target and level["uniquePlayerIds"] == target and
              unexpected == 0 and errors == 0 and rejected == 0 and
              level["movementAckP95Ms"] is not None and level["movementAckP95Ms"] <= 500
            )
            report["levels"].append(level)
            save()
            if not level["passed"]:
                report["stopReason"] = "level-failed"
                save(); return 8

          report["complete"] = True
          save()
          return 0
        finally:
          cleanup = []
          for page in pages:
            try: cleanup.append(stop_and_delete(page))
            except Exception: cleanup.append({"deleted":False,"code":"cleanup-exception"})
          report["cleanup"] = {
            "temporaryUsers": len(cleanup),
            "deleted": sum(1 for x in cleanup if x.get("deleted")),
            "failures": sum(1 for x in cleanup if not x.get("deleted"))
          }
          save()
          for context in contexts:
            try: context.close()
            except Exception: pass
          browser.close()
    except PlaywrightTimeoutError:
      report["stopReason"] = "browser-timeout"; save(); return 9
    except Exception as e:
      report["stopReason"] = "canary-exception:" + type(e).__name__; save(); return 10

if __name__ == "__main__":
    sys.exit(main())
