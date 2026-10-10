# P1 protocol inventory and gate repair

Inspected baseline: P0 commit `0acbdf43a94c9c228e07957cf2828c1c99a6e83a`.
The inspection uses that Git commit and the active P1 source only.

## Failure cause

The first P1 gate's new extractor collected every literal property named `type`
except the Slip2go option `eq`. It included `state.pendingPayment.type: null`
from P0 `index.html:602`, now in `src/client/auth-state.js`. This is the initial
unselected payment item, read by the existing payment form logic. It is not sent
as a WebSocket packet type.

The recorded failure was **28 valid strings versus the same 28 strings plus
null (29 entries)**. The description “27 versus 28” did not match the gate log.
No message was missing. Runtime protocol code was not changed by this repair.

`tests/rebuild/wire-inventory.cjs` now inspects actual send/broadcast arguments,
local packet/event aliases passed to those calls, and `m.type`/`message.type`
dispatch comparisons and switch cases. It does not treat UI state or HTTP request
options as WebSocket messages. An invalid discriminator in an actual authored
wire send fails inspection rather than silently disappearing.

P1 tests compare the complete type set and occurrence histogram against P0,
require every authored Worker/client wire reference to use shared `WS_MESSAGE`,
and require its single declaration in `src/shared/protocol.mjs`. The generated
`index.html` is a checked build artifact. The unrelated RTDB sort field `score`
remains an ordinary database field name. No test is deleted or skipped.

## WebSocket vocabulary

There are **28 distinct message types**, with protocol versions 4 (GameRoom)
and 6 (ZoneRoom), both unchanged. Directions describe existing authored traffic;
they do not imply new acceptance or validation rules.

| Type | Direction |
| --- | --- |
| `auth` | client → server |
| `auth_error` | server → client |
| `auth_refreshed` | server → client |
| `box_error` | server → client |
| `box_reward` | server → client |
| `box_spin_ready` | server → client |
| `box_state` | server → client |
| `coin_collect_result` | server → client |
| `coin_collected` | server → client |
| `coin_state` | server → client |
| `collect` | client → server |
| `collect_box` | client → server |
| `ghost_snapshot` | server → client |
| `handoff_cancel` | client → server |
| `handoff_cancelled` | server → client |
| `handoff_error` | server → client |
| `handoff_resume` | client → server |
| `handoff_resume_error` | server → client |
| `handoff_resumed` | server → client |
| `join` | server → client |
| `leaderboard` | server → client |
| `leave` | server → client |
| `move` | both directions |
| `score` | server → client |
| `server_error` | server → client |
| `spin_box` | client → server |
| `welcome` | server → client |
| `zone_change` | server → client |

## HTTP contracts

| Path | Existing owner/behavior |
| --- | --- |
| `/health` | Default Worker health response |
| `/entitlements` | Default Worker GET/OPTIONS handler |
| `/verify-slip` | Default Worker POST/OPTIONS handler |
| `/play` | Default Worker WebSocket upgrade; optional `zone` routing |
| `/_internal/get-entitlements` | GameRoom entitlement response |
| `/_internal/create-zone-handoff` | GameRoom transfer creation |
| `/_internal/consume-zone-handoff` | GameRoom transfer consumption |
| `/_internal/zone-collect` | GameRoom coin action |
| `/_internal/zone-collect-box` | GameRoom box claim |
| `/_internal/zone-spin-box` | GameRoom box reward |
| `/_internal/zone-bootstrap` | GameRoom bootstrap |
| `/_internal/grant-payment` | GameRoom payment grant |
| `/_internal/border-state` | ZoneRoom border state |
| `/_internal/border-snapshot` | ZoneRoom border snapshot |
| `/_internal/world-event` | ZoneRoom event relay |

The existing zone routing adapter constructs `/play-zone/${zoneX}/${zoneZ}`.
Internal event relays carry the same shared wire vocabulary. HTTP JSON uses
existing `ok`, `error`, entitlement/state/action fields, rather than a separate
WebSocket `type` namespace. The existing Slip2go request contains
`payload.checkAmount.type: 'eq'`; it is an amount comparison option, not a
game message. The Firebase certificate and Slip2go provider URLs are unchanged.

P1 adds no endpoint, wire message, protocol validation, auth policy, security
policy, economy policy or external request. Payment tests remain synthetic.
