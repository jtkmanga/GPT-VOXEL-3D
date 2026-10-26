# PromptPay Production Onboarding

Status: code prepared; production payment remains disabled until merchant onboarding is complete.

## Provider request
Ask 2C2P Thailand for:
- Production Payment Gateway merchant account
- THB settlement
- Thai QR / PromptPay capability
- Group: THQR
- Channel: PPQR
- Production Merchant ID
- Production Secret Key

Production client domain:
- https://jtkmanga.github.io

Production Worker / backend callback origin:
- https://voxel-run-v2-demo.hjinffv5426.workers.dev
- Backend notification URL: https://voxel-run-v2-demo.hjinffv5426.workers.dev/payments/promptpay/backend

## Secret handling
Never commit or paste the production Secret Key into source, issues, pull requests, chat, screenshots, or logs.

When issued:
1. Store Merchant ID in the protected GitHub production environment secret named:
   PRODUCTION_TWOC2P_MERCHANT_ID
2. Store Secret Key in the protected GitHub production environment secret named:
   PRODUCTION_TWOC2P_SECRET_KEY
3. Set production environment variable:
   PRODUCTION_TWOC2P_PROMPTPAY_CAPABILITY_VERIFIED=true
4. Do not change baseline wrangler.jsonc. It must stay PAYMENT_MODE=disabled.

## Release sequence
1. Merge only after review and owner approval.
2. Run PromptPay Production Readiness with confirmation:
   CHECK-PROMPTPAY-PRODUCTION
3. Deploy Canary with:
   rollout=canary
   confirm=DEPLOY-PROMPTPAY-CANARY
4. Verify health, signed callback path, config, App Check, Firebase auth and payment-disabled checkout.
5. Plan and authorize one small real PromptPay transaction.
6. Deploy Public with:
   rollout=public
   confirm=DEPLOY-PROMPTPAY-PUBLIC
7. Complete one real PromptPay payment and confirm:
   - provider signature verifies
   - invoice/amount/currency match
   - duplicate callback is idempotent
   - VIP entitlement is granted exactly once
   - VIP remains after re-login
8. Monitor and keep the admin payment emergency switch available.

## Safety properties
- Browser never supplies the authoritative VIP price.
- Browser never grants entitlement.
- Dynamic QR is created per invoice.
- Payment provider callback is signed and server-verified.
- Duplicate invoice, transaction and callback replay are fenced.
- Legacy slip verification stays disabled for VIP PromptPay.
