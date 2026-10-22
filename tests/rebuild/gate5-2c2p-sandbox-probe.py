#!/usr/bin/env python3
import base64, hashlib, hmac, json, re, sys, time, urllib.request
from urllib.parse import urlparse

DOC_URL = "https://developer.2c2p.com/v4.0.2/docs/sandbox"
API_URL = "https://sandbox-pgw.2c2p.com/payment/4.5/paymentToken"
EXPECTED_HPP = "https://sandbox-pgw-ui.2c2p.com"
OUT = "work/gate5/2c2p-sandbox-probe.json"

def b64u(data):
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")

def jwt_sign(payload, secret):
    header = b64u(b'{"alg":"HS256","typ":"JWT"}')
    body = b64u(json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode())
    signed = (header + "." + body).encode()
    sig = b64u(hmac.new(secret.encode(), signed, hashlib.sha256).digest())
    return header + "." + body + "." + sig

def jwt_verify(token, secret):
    parts = token.split(".")
    if len(parts) != 3:
        raise RuntimeError("invalid-jwt")
    signed = (parts[0] + "." + parts[1]).encode()
    actual = base64.urlsafe_b64decode(parts[2] + "=" * (-len(parts[2]) % 4))
    expected = hmac.new(secret.encode(), signed, hashlib.sha256).digest()
    if not hmac.compare_digest(actual, expected):
        raise RuntimeError("invalid-signature")
    return json.loads(base64.urlsafe_b64decode(parts[1] + "=" * (-len(parts[1]) % 4)))

def fetch_text(url):
    req = urllib.request.Request(url, headers={"User-Agent":"VOXEL-Gate5-Sandbox-Probe/1.0"})
    with urllib.request.urlopen(req, timeout=20) as r:
        final = urlparse(r.geturl())
        if final.scheme != "https" or final.hostname != "developer.2c2p.com":
            raise RuntimeError("unexpected-doc-origin")
        return r.read(2_000_000).decode("utf-8", "replace")

def demo_thailand():
    text = fetch_text(DOC_URL)
    pos = text.upper().find("THAILAND")
    if pos < 0:
        raise RuntimeError("thailand-demo-not-found")
    window = text[pos:pos+12000]
    merchant = re.search(r"JT04", window)
    key = re.search(r"\b[A-Fa-f0-9]{64}\b", window)
    if not merchant or not key:
        raise RuntimeError("demo-credential-format-not-found")
    return "JT04", key.group(0)

def post_json(url, body):
    req = urllib.request.Request(url, data=json.dumps(body).encode(), method="POST",
      headers={"Content-Type":"application/json","User-Agent":"VOXEL-Gate5-Sandbox-Probe/1.0"})
    with urllib.request.urlopen(req, timeout=20) as r:
        final = urlparse(r.geturl())
        if final.scheme != "https" or final.hostname != "sandbox-pgw.2c2p.com":
            raise RuntimeError("unexpected-api-origin")
        return json.loads(r.read(100_000).decode())

def main():
    import os
    os.makedirs("work/gate5", exist_ok=True)
    report={"complete":False,"provider":"2C2P","environment":"sandbox","country":"TH",
      "currency":"THB","merchantDemo":True,"secretRecorded":False,"tokenRecorded":False}
    try:
        merchant, secret = demo_thailand()
        stamp = str(int(time.time()))
        invoice = ("VX" + stamp)[-20:]
        prefix = ("VXR" + stamp)[-15:]
        now = time.gmtime()
        day = min(max(now.tm_mday,1),28)
        payload={
          "merchantID":merchant,"invoiceNo":invoice,
          "description":"VOXEL VIP sandbox probe","amount":50,"currencyCode":"THB",
          "paymentChannel":["CC"],"frontendReturnUrl":"https://gpt-voxel-3d-staging-01.hjinffv5426.workers.dev/payments/2c2p/return",
          "backendReturnUrl":"https://gpt-voxel-3d-staging-01.hjinffv5426.workers.dev/payments/2c2p/backend",
          "recurring":True,"invoicePrefix":prefix,"recurringAmount":50,
          "allowAccumulate":False,"maxAccumulateAmount":0,"recurringCount":0,
          "chargeOnDate":f"{day:02d}{now.tm_mon:02d}"
        }
        envelope=post_json(API_URL,{"payload":jwt_sign(payload,secret)})
        if set(envelope) != {"payload"} or not isinstance(envelope["payload"],str):
            raise RuntimeError("unexpected-response-envelope")
        response=jwt_verify(envelope["payload"],secret)
        if response.get("respCode") != "0000" or not response.get("paymentToken"):
            raise RuntimeError("payment-token-rejected:" + str(response.get("respCode","unknown")))
        hpp=response.get("webPaymentUrl")
        parsed=urlparse(hpp or "")
        if parsed.scheme!="https" or parsed.netloc!="sandbox-pgw-ui.2c2p.com" or parsed.path!="/payment/4.5/":
            raise RuntimeError("unexpected-hosted-payment-url")
        report.update({"complete":True,"merchantID":merchant,"respCode":"0000",
          "paymentTokenIssued":True,"hostedPaymentOrigin":EXPECTED_HPP,
          "hostedPaymentPath":parsed.path,"recurringRequested":True,
          "monthlyChargeOnDateRequested":True,"amount":50})
        code=0
    except Exception as e:
        report["error"]=str(e)[:160]
        code=1
    with open(OUT,"w",encoding="utf-8") as f:
        json.dump(report,f,indent=2,sort_keys=True)
    print(json.dumps({k:v for k,v in report.items() if k not in {"error"}},sort_keys=True))
    return code

if __name__ == "__main__":
    sys.exit(main())
