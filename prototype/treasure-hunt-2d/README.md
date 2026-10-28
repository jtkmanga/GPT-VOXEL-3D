# GPT Treasure Hunt 2D — Offline Mobile Prototype

**Status:** P1/P2 standalone visual/playable prototype only. **Not** production; no network requests, Firebase, real payment, entitlements, persistent inventory, leaderboard, or live online capacity claim.

This prototype was derived as a separate feature branch from development/voxel-continuous at ef08025c8f730fc10c658206f939e94bb8b1b0d2 on 2026-10-28. It must not replace the existing 3D game, production Worker, deployed assets, scores, or payments.

## Try on a phone

Open/download index.html and open that file in a modern browser that supports Canvas 2D and Pointer Events. A static web server can also serve it (no build or backend required). Tap **เริ่มด่าน** (start) and drag the joystick to move. Tap **เก็บ** to pick up nearby coins or the treasure chest. Keyboard: WASD / arrow keys to move, Space to collect.

No hosting, billing or account changes are performed by this commit.

## Included

- One self-contained HTML5 canvas game with a responsive touchscreen joystick and keyboard controls.
- Three deterministic demo biomes (forest, cave, temple), walls/obstacles and a collision-aware player.
- 82 demo coins per level (below the proposed 200 cap). A collected coin locally respawns 60 seconds after collection.
- One demo chest that awards points once per local four-hour cooldown.
- Three-minute playable rounds, local score and wallet, demo result modal and shop.
- Sample leaderboard and VIP price label, **explicitly illustrative**. The prototype does not mint real score, VIP rights, credit or rewards.

## Run checks

node prototype/treasure-hunt-2d/smoke.test.cjs

The smoke test validates parse/runtime boot with a mocked Canvas/DOM, mobile tags, no network invocation, coin/chest counts, collision, score changes, cooldown anti-double-claim, canvas frame, and ranking modal. It is **not** a real mobile/browser, Firebase or staging test.

## Proposed online architecture (NOT implemented)

| Feature | Next implementation |
| --- | --- |
| Identity | Reuse src/worker/firebase-auth.mjs to verify Google login and App Check |
| Run/score | Server-issued run ID, short-lived seed, validated completion and deduplicated scoring; client never decides authorized credit |
| Coins | Personal per-run coins, no per-coin requests; validate bounds and elapsed-time on completion |
| Lucky Box | Separate Free/VIP global event-cycle records with conditional atomic claim, 4-hour server-based cooldown |
| Rankings | Read-only cached top N and separate competition period IDs; Free resets Sundays 00:00 Asia/Bangkok, VIP daily 00:00 |
| Shop/VIP | Reuse catalog, admin pricing and verified Slip2Go payment boundary only after separate security review; no paid score boosts |
| Admin | Reuse current owner/role authorization but adapt backend to no-WebSocket HTTP |
| Hosting | Static assets + Cloudflare Workers Free + D1 free allowances, subject to actual quotas and load budget |

**Security note:** A player-controlled HTML/Canvas game cannot be made cheat-proof by checking user-supplied points, claimed position, a client-supplied seed or a replay hash. A competitive mode must verify gameplay inputs/results against server-authored constraints, enforce time/rate budgets, and audit anomalies before awarding rankings. The present version is an offline UI/gameplay proof of concept only.

**Cost note:** Free tiers have usage limits. A 1,000-player 24/7 service is not guaranteed to fit the Workers/D1 free quotas; we must load-test the proposed HTTP request pattern and measure row reads/writes before launch.

## Next bounded steps

1. Test the HTML on Android Chrome/Samsung Browser (touch controls, frame rate, draw size, modals), fix observed issues.
2. Implement and test server-issued run IDs and a tamper-resistant bounded score-verification design in an isolated staging environment.
3. Move score, account, leaderboard and Lucky Box event state to verified HTTP endpoints without persistent client WebSockets.
4. Integrate existing shop, VIP, Slip2Go and Admin only after payment/permission regression tests.
5. Benchmark API and D1 daily usage at 1K daily/1K constant players, with explicit cost/abort limits; run small canaries before larger tests.

**Files affected:** This prototype folder only. **No main/prod deployment or billable infrastructure changes.**
