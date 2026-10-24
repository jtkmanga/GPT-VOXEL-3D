# P7: VIP entitlement and admission

P7 starts from verified P6 `33ace23c05875734eda909973b446a376bf307ae`.
Free gameplay keeps its existing `free-v2-demo` economic authority and 10×10
ZoneRoom transport. VIP uses a separate named `GameRoom`, `vip1-v2-demo`, with
its own authoritative world, 200 coins, Lucky Box, scores and persistent player
checkpoints. A private router initialization durably sets its VIP scope; its
events never fan out to Free zones. Existing Durable Object bindings and
migrations remain unchanged.

## Provider-neutral boundary

`POST /payments/webhook` is a backend integration boundary, not a browser
payment-confirmation endpoint. Without a server-only `PAYMENT_WEBHOOK_SECRET`
of at least 32 UTF-8 bytes it fails closed. The rebuild contains only synthetic
test signing material; no real provider adapter, production credential, charge,
checkout or subscription is configured.

An adapter signs `timestamp + '.' + rawBody` using HMAC SHA-256 and supplies the
hex signature in `x-provider-signature`, with Unix seconds in
`x-provider-timestamp`. Signature delivery must be within five minutes of the
server clock. UTF-8 JSON is streamed with a 16 KiB limit before parsing. Exact
schema: `eventId`, `subscriptionId`, `uid`, positive integer `version`,
`status` (`active`, `expired`, `revoked`), `product` (`vip1`), numeric `amount`
(`50`), `currency` (`THB`), integer `periodStart`, integer `periodEnd`. A period
is the existing catalog's 30 days, representing the 50 THB/month product
intent. Future periods grant no access before their start.

Semantic payload fingerprints make JSON whitespace and property order harmless
on retries. A durable event ID receipt returns the original result on identical
redelivery and rejects conflicting content. Subscription versions must increase;
stale events cannot reverse revocation. A subscription ID remains bound to its
original UID, and this neutral adapter conservatively supports one subscription
ID per UID. Provider-specific subscription replacement and real merchant event
verification still need an explicitly configured provider adapter.

Lifecycle updates, entitlement persistence and receipts commit together in one
SQLite transaction. They update only VIP state and preserve existing speed and
coin buffs. Revoked/expired subscription status overrides any legacy raw expiry
write. The existing backend-verified slip flow and its historical 100-active-
entitlement sales limit remain compatible; that policy is separate from
concurrent VIP seats. Webhook entitlement holders may exceed 100.

## Seats and session ownership

The Free coordinator owns central VIP seats and entitlements under one SQLite
transaction lock. Admission reads the current entitlement and counts live
authenticated leases; it admits at most 100 simultaneous players and rejects
the 101st. One UID owns at most one seat. The server generates the session ID;
the client never chooses an authoritative UID, VIP flag or seat generation.

A replacement uses compare-and-set against the observed central generation.
Durable retired-generation records reject delayed admission, renewal or close
callbacks from older sessions. Lease expiry is the minimum of 120 seconds,
verified Firebase token expiry and entitlement expiry. Every VIP action checks
local ownership and the current central seat, then rechecks local ownership
after the RPC. Refreshes mirror trusted speed, coin and VIP entitlements.

Inactive or shortened entitlement events retire their exact central generation
and invalidate/close that generation in the VIP room before acknowledging the
webhook. The generation is retained in the durable receipt so an interrupted
delivery retries safely. A delayed successful validation response cannot revive
the invalidated local lease or mutate its economy. Idle expired players do not
appear in counts, nearby names, fan-out or Lucky Box spawn avoidance. The VIP
room prunes expired authenticated transports before its bounded pending-
connection transport cap can obstruct future admission.

## Verification scope

P7 tests include signature/config/schema failures; price and payment forgery;
semantic duplicate receipts; version and subscription ownership fences;
activation, future starts, expiry, revocation and shortening; transaction
rollback/retry; restart persistence; valid and invalid Firebase sessions; 100
seats and 101st rejection; concurrent capacity and duplicate-UID races;
replacement/reconnect/stale callbacks; held validation across revocation;
revocation retry after a synthetic RPC failure; Free/VIP economy isolation;
100 idle expired players; and repeated expired cohorts without transport leaks.
All network access runs through the local deny-by-default rebuild harness.

The complete phase gate also runs every active P0–P6 behavioral regression,
unaltered historical source proofs, legacy assertions, browser tests, generated
client/static/syntax checks, full rebuild diff and secret/config scans, and
Wrangler's bundle dry-run. This provides a tested checkpoint, not a production
deployment, real payment validation or evidence of 10,000 real concurrent
players.

Completed HARD GATE: 318 tests passed, zero failed or skipped (308 Node,
2 legacy smoke tests, 8 isolated Chromium tests); 43 legacy assertions and
95 syntax units passed. Static/generated-client checks, staged/full diff checks,
secret/config scan and Wrangler bundle dry-run all passed. No production
deployment or payment was performed.
