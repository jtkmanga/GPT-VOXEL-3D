# Slip2Go Production Payment Runbook

Status: code prepared. Production payment remains disabled until owner-approved rollout.

## Provider
VOXEL RUN uses Slip2Go API Connect for PromptPay QR image generation and slip-image verification. The Worker checks duplicate slips, receiver identity, and the exact server-owned amount.

Endpoints:
- POST /api/qr-payment/generate-qr-image-link
- POST /api/verify-slip/qr-image/info

The browser never receives the Slip2Go API Secret or PromptPay receiver identifier.

## Protected Cloudflare bindings
Production must retain:
- SLIP2GO_API_SECRET
- PAYMENT_RECEIVER_ACCOUNT

PAYMENT_RECEIVER_TYPE is prepared as phone_number unless deliberately changed after receiver verification. The display label defaults to Lucky Game and is not payment authority.

## Safety model
- Base wrangler.jsonc remains PAYMENT_MODE=disabled.
- Browser sends only item id; price comes from Admin/server pricing.
- Worker creates the PromptPay QR with server-owned receiver and amount.
- Slip verification checks duplicate, receiver and exact amount.
- Durable transaction ledger prevents a slip granting twice.
- vip1 grants 30 days only after verified payment.
- Canary allows payment only for ADMIN_OWNER_EMAIL.
- Public rollout requires a second explicit confirmation.

## Before canary
1. Slip2Go API package is active.
2. API Secret is valid.
3. PAYMENT_RECEIVER_ACCOUNT is the intended PromptPay receiver.
4. QR and slip verification quota are available.
5. If Slip2Go IP Whitelist is enabled, confirm it is compatible with Cloudflare Worker egress.

## Release sequence
1. Merge after tests and owner approval.
2. Run Slip2Go Production Readiness with CHECK-SLIP2GO-PRODUCTION.
3. Deploy canary with rollout=canary and confirm=DEPLOY-SLIP2GO-CANARY.
4. Owner signs in on the real production site.
5. Buy one VIP item using the intended live amount.
6. Confirm QR receiver/amount, transfer success, verified slip, one 30-day VIP grant, duplicate rejection, relogin persistence, and non-owner denial during canary.
7. Deploy public only after owner approval with rollout=public and confirm=DEPLOY-SLIP2GO-PUBLIC.
8. Keep Admin payment emergency pause available.

## Rollback
Use the normal production deployment path with PRODUCTION_PAYMENT_MODE=disabled. Do not delete Slip2Go secrets; disabling payment mode is enough to fail closed.
