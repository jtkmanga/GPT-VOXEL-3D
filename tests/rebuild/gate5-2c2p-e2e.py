#!/usr/bin/env python3
import json, os, re, time, urllib.request, uuid
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import sync_playwright

ORIGIN = "https://gpt-voxel-3d-staging-01.hjinffv5426.workers.dev"
HPP_ORIGIN = "https://sandbox-pgw-ui.2c2p.com"
CARD_DOC = "https://developer.2c2p.com/docs/reference-test-information-th.md"
OUT = Path("work/gate5/2c2p-e2e.json")


def official_sandbox_card():
    request = urllib.request.Request(CARD_DOC, headers={"User-Agent": "VOXEL-Gate5-E2E/1.0"})
    with urllib.request.urlopen(request, timeout=20) as response:
        text = response.read(1_000_000).decode("utf-8", "replace")
    match = re.search(
        r"Visa\s*\|\s*`?(\d{16})`?.{0,240}?CVV\s*:?\s*`?(\d{3})`?.{0,120}?OTP\s*:?\s*`?(\d{6})`?",
        text, re.IGNORECASE | re.DOTALL)
    if not match:
        raise RuntimeError("official-sandbox-card-unavailable")
    return match.groups()


def first_visible(container, selectors):
    for selector in selectors:
        locator = container.locator(selector)
        for index in range(locator.count()):
            candidate = locator.nth(index)
            if candidate.is_visible() and candidate.is_enabled():
                return candidate
    return None


def click_positive(container):
    buttons = container.locator("button, input[type=submit], input[type=button]")
    for index in range(buttons.count()):
        button = buttons.nth(index)
        if not button.is_visible() or not button.is_enabled():
            continue
        label = ((button.inner_text() if button.evaluate("e => e.tagName === 'BUTTON'") else
                  button.get_attribute("value")) or "").strip()
        if re.search(r"cancel|back|close", label, re.IGNORECASE):
            continue
        if re.search(r"continue payment|submit|confirm|continue|proceed|pay|verify|^ok$", label, re.IGNORECASE):
            button.click()
            return True
    return False


def checkout(page):
    return page.evaluate("""async requestId => {
      await firebase.auth().signInAnonymously();
      const user = firebase.auth().currentUser;
      if (!user) return {ok:false, stage:'anonymous-auth'};
      if (firebase.appCheck) await firebase.appCheck().getToken(false);
      const token = await user.getIdToken(true);
      const activeResponse = await fetch('/entitlements', {headers:{Authorization:'Bearer '+token}});
      if (!activeResponse.ok) {
        let lookupStatus=0, lookupMatched=false, lookupDisabled=null;
        try {
          const apiKey=firebase.app().options.apiKey;
          const lookup=await fetch('https://identitytoolkit.googleapis.com/v1/accounts:lookup?key='+encodeURIComponent(apiKey), {
            method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({idToken:token})
          });
          lookupStatus=lookup.status;
          const data=await lookup.json().catch(() => ({}));
          const users=Array.isArray(data?.users)?data.users:[];
          lookupMatched=users.length===1 && users[0]?.localId===user.uid;
          lookupDisabled=lookupMatched ? users[0]?.disabled===true : null;
        } catch (_) {}
        return {ok:false, stage:'worker-active-auth-rejected', status:activeResponse.status,
          lookupStatus, lookupMatched, lookupDisabled};
      }
      const response = await fetch('/payments/2c2p/checkout', {
        method:'POST', headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},
        body:JSON.stringify({requestId})
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || !body?.ok) {
        const known = new Map([
          ['Staging sign-in required','staging-sign-in-required'],
          ['Origin not allowed','origin-not-allowed'],
          ['2C2P sandbox payment actions are disabled','payment-actions-disabled'],
          ['2C2P sandbox signing boundary is unavailable','signing-boundary-unavailable'],
          ['Sandbox payment authority unavailable','payment-authority-unavailable'],
          ['Sandbox payment token request failed','payment-token-request-failed'],
          ['Sandbox payment token request rejected','payment-token-request-rejected'],
          ['Sandbox payment token response unverified','payment-token-response-unverified'],
          ['Sandbox hosted checkout unavailable','hosted-checkout-unavailable']
        ]);
        return {ok:false, stage:known.get(body?.error)||'checkout-response', status:response.status};
      }
      return {ok:true, invoiceNo:body.invoiceNo, webPaymentUrl:body.webPaymentUrl};
    }""", "gate5e2e:" + uuid.uuid4().hex)


def submit_hpp(page, card, cvv, otp):
    card_input = first_visible(page, [
        "input[placeholder*='Credit Card Number' i]", "input[name='cardNumber']",
        "input[placeholder*='0000-0000' i]"])
    month_input = first_visible(page, ["input[placeholder='MM']", "input[placeholder*='month' i]"])
    year_input = first_visible(page, ["input[placeholder='YYYY']", "input[placeholder*='year' i]"])
    cvv_input = first_visible(page, ["input[placeholder*='CVV' i]", "input[placeholder*='CVC' i]", "input[type=password]"])
    email_input = first_visible(page, ["input[type=email]", "input[name=email]"])
    if not all([card_input, month_input, year_input, cvv_input, email_input]):
        raise RuntimeError("hpp-card-form-unavailable")
    card_input.fill(card)
    month_input.fill("12")
    year_input.fill(str(time.gmtime().tm_year + 2))
    cvv_input.fill(cvv)
    email_input.fill("voxel-gate5@example.com")
    if not click_positive(page):
        raise RuntimeError("hpp-submit-unavailable")

    deadline = time.monotonic() + 90
    otp_submitted = False
    while time.monotonic() < deadline:
        if page.url.startswith(ORIGIN):
            return otp_submitted, True
        for frame in page.frames:
            try:
                text = frame.locator("body").inner_text(timeout=1000)[:20_000]
                otp_input = first_visible(frame, [
                    "input[name*='otp' i]", "input[id*='otp' i]", "input[placeholder*='otp' i]",
                    "input[aria-label*='otp' i]"])
                if otp_input is None and re.search(r"OTP|ONE.TIME.PASSWORD", text, re.IGNORECASE):
                    editable = [frame.locator("input").nth(i) for i in range(frame.locator("input").count())]
                    editable = [item for item in editable if item.is_visible() and item.is_enabled() and
                                (item.get_attribute("type") or "text") not in ("hidden", "submit", "button")]
                    if len(editable) == 1:
                        otp_input = editable[0]
                if otp_input is not None and not otp_submitted:
                    otp_input.fill(otp)
                    if not click_positive(frame):
                        otp_input.press("Enter")
                    otp_submitted = True
            except Exception:
                continue
        page.wait_for_timeout(1000)
    return otp_submitted, page.url.startswith(ORIGIN)


def verify_backend(context, invoice_no):
    page = context.new_page()
    page.goto(ORIGIN, wait_until="domcontentloaded", timeout=30_000)
    page.wait_for_function("typeof firebase !== 'undefined' && firebase.apps && firebase.apps.length > 0", timeout=30_000)
    result = page.evaluate("""async invoiceNo => {
      const user = await new Promise(resolve => {
        let stop = () => {};
        stop = firebase.auth().onAuthStateChanged(value => { stop(); resolve(value); });
      });
      if (!user) return {ok:false, stage:'auth-session-missing'};
      for (let attempt=0; attempt<20; attempt++) {
        const token = await user.getIdToken(attempt===0);
        const statusResponse = await fetch('/payments/2c2p/status?invoiceNo='+encodeURIComponent(invoiceNo),
          {headers:{Authorization:'Bearer '+token}});
        const status = await statusResponse.json().catch(() => ({}));
        if (statusResponse.ok && status?.ok && status.status === 'paid') {
          const entitlementResponse = await fetch('/entitlements', {headers:{Authorization:'Bearer '+token}});
          const entitlement = await entitlementResponse.json().catch(() => ({}));
          const active = entitlementResponse.ok && entitlement?.active?.vip1 === true &&
            Number(entitlement?.entitlements?.vip1Expires || 0) > Date.now();
          return {ok:active, stage:active?'verified':'entitlement-inactive', backendStatus:status.status,
            entitlementActive:active};
        }
        if (['failed','cancelled','expired'].includes(status?.status))
          return {ok:false, stage:'terminal-provider-status', backendStatus:status.status};
        await new Promise(resolve => setTimeout(resolve,1500));
      }
      return {ok:false, stage:'backend-callback-pending'};
    }""", invoice_no)
    deleted = page.evaluate("""async () => {
      try { const user=firebase.auth().currentUser; if (user) await user.delete(); return true; }
      catch (_) { return false; }
    }""")
    page.close()
    return result, deleted


def main():
    OUT.parent.mkdir(parents=True, exist_ok=True)
    report = {"formatVersion": 1, "environment": "2c2p-thailand-sandbox", "complete": False,
              "realMoney": False, "cardRecorded": False, "otpRecorded": False,
              "tokenRecorded": False, "personalEmailRecorded": False}
    stage = "startup"
    try:
        debug_token = os.environ.get("FIREBASE_APPCHECK_DEBUG_TOKEN", "").strip()
        if not debug_token:
            raise RuntimeError("appcheck-debug-token-unavailable")
        stage = "official-test-card"
        card, cvv, otp = official_sandbox_card()
        stage = "browser"
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            context = browser.new_context()
            context.add_init_script("self.FIREBASE_APPCHECK_DEBUG_TOKEN = " + json.dumps(debug_token) + ";")
            page = context.new_page()
            page.goto(ORIGIN, wait_until="domcontentloaded", timeout=30_000)
            page.wait_for_function("typeof firebase !== 'undefined' && firebase.apps && firebase.apps.length > 0", timeout=30_000)
            stage = "checkout"
            created = checkout(page)
            if not created.get("ok"):
                report["checkoutHttpStatus"] = int(created.get("status") or 0)
                report["firebaseLookupHttpStatus"] = int(created.get("lookupStatus") or 0)
                report["firebaseLookupMatched"] = bool(created.get("lookupMatched"))
                report["firebaseLookupDisabled"] = created.get("lookupDisabled")
                report["errorStage"] = str(created.get("stage") or "checkout-failed")[:80]
                raise RuntimeError(str(created.get("stage") or "checkout-failed"))
            invoice_no, hpp_url = created.get("invoiceNo"), created.get("webPaymentUrl")
            hosted = urlparse(str(hpp_url or ""))
            if hosted.scheme + "://" + hosted.netloc != HPP_ORIGIN or hosted.path != "/payment/4.5/":
                raise RuntimeError("unexpected-hpp-destination")
            report["checkoutCreated"] = True
            stage = "hpp-card"
            page.goto(hpp_url, wait_until="domcontentloaded", timeout=45_000)
            otp_submitted, returned = submit_hpp(page, card, cvv, otp)
            report.update({"hppSubmitted": True, "otpSubmitted": otp_submitted, "returnedToStaging": returned})
            stage = "backend-status"
            verified, deleted = verify_backend(context, invoice_no)
            report.update({"backendStatus": verified.get("backendStatus"),
                           "entitlementActive": bool(verified.get("entitlementActive")),
                           "temporaryUserDeleted": deleted})
            report["complete"] = bool(verified.get("ok"))
            if not report["complete"]:
                report["errorStage"] = str(verified.get("stage") or stage)[:80]
            context.close()
            browser.close()
    except Exception as error:
        if "errorStage" not in report:
            report["errorStage"] = stage
        report["errorClass"] = type(error).__name__
    OUT.write_text(json.dumps(report, indent=2, sort_keys=True), encoding="utf-8")
    print(json.dumps({key: report.get(key) for key in (
        "complete", "environment", "checkoutCreated", "hppSubmitted", "otpSubmitted",
        "returnedToStaging", "backendStatus", "entitlementActive", "temporaryUserDeleted",
        "checkoutHttpStatus", "firebaseLookupHttpStatus", "firebaseLookupMatched",
        "firebaseLookupDisabled", "errorStage")},
        sort_keys=True))
    return 0 if report["complete"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
