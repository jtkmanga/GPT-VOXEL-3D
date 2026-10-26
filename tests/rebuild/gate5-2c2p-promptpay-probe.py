#!/usr/bin/env python3
import base64, hashlib, hmac, json, re, sys, time, urllib.request, uuid
from urllib.parse import urlparse

DOC_URL = "https://developer.2c2p.com/v4.0.2/docs/sandbox.md"
TOKEN_URL = "https://sandbox-pgw.2c2p.com/payment/4.5/paymentToken"
PAY_URL = "https://sandbox-pgw.2c2p.com/payment/4.5/payment"
OUT = "work/gate5/2c2p-promptpay-probe.json"

def b64u(data):
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")

def jwt_sign(payload, secret):
    header=b64u(b'{"alg":"HS256","typ":"JWT"}')
    body=b64u(json.dumps(payload,separators=(",",":"),ensure_ascii=False).encode())
    signed=(header+"."+body).encode()
    sig=b64u(hmac.new(secret.encode(),signed,hashlib.sha256).digest())
    return header+"."+body+"."+sig

def jwt_verify(token, secret):
    parts=token.split(".")
    if len(parts)!=3: raise RuntimeError("invalid-jwt")
    signed=(parts[0]+"."+parts[1]).encode()
    actual=base64.urlsafe_b64decode(parts[2]+"="*(-len(parts[2])%4))
    expected=hmac.new(secret.encode(),signed,hashlib.sha256).digest()
    if not hmac.compare_digest(actual,expected): raise RuntimeError("invalid-signature")
    return json.loads(base64.urlsafe_b64decode(parts[1]+"="*(-len(parts[1])%4)))

def fetch_text(url):
    req=urllib.request.Request(url,headers={"User-Agent":"VOXEL-PromptPay-Sandbox-Probe/1.0"})
    with urllib.request.urlopen(req,timeout=20) as r:
        final=urlparse(r.geturl())
        if final.scheme!="https" or final.hostname!="developer.2c2p.com":
            raise RuntimeError("unexpected-doc-origin")
        return r.read(2_000_000).decode("utf-8","replace")

def demo_thailand():
    text=fetch_text(DOC_URL)
    pos=text.upper().find("THAILAND")
    if pos<0: raise RuntimeError("thailand-demo-not-found")
    window=text[pos:pos+12000]
    merchant=re.search(r"JT04",window)
    key=re.search(r"\b[A-Fa-f0-9]{64}\b",window)
    if not merchant or not key: raise RuntimeError("demo-credential-format-not-found")
    return "JT04",key.group(0)

def post_signed(url,payload,secret):
    req=urllib.request.Request(url,data=json.dumps({"payload":jwt_sign(payload,secret)}).encode(),
      method="POST",headers={"Content-Type":"application/json","User-Agent":"VOXEL-PromptPay-Sandbox-Probe/1.0"})
    with urllib.request.urlopen(req,timeout=20) as r:
        final=urlparse(r.geturl())
        if final.scheme!="https" or final.hostname!="sandbox-pgw.2c2p.com":
            raise RuntimeError("unexpected-api-origin")
        envelope=json.loads(r.read(100_000).decode())
    if set(envelope)!={"payload"} or not isinstance(envelope.get("payload"),str):
        keys=",".join(sorted(str(k) for k in envelope.keys())) if isinstance(envelope,dict) else type(envelope).__name__
        code=envelope.get("respCode",envelope.get("code","none")) if isinstance(envelope,dict) else "none"
        raise RuntimeError("unexpected-response-envelope:keys="+keys+";code="+str(code)[:24])
    return jwt_verify(envelope["payload"],secret)

def main():
    import os
    os.makedirs("work/gate5",exist_ok=True)
    report={"complete":False,"provider":"2C2P","environment":"sandbox","country":"TH",
      "currency":"THB","channel":"PPQR","merchantDemo":True,"secretRecorded":False,
      "paymentTokenRecorded":False,"qrUrlRecorded":False,"paymentExecuted":False}
    try:
        merchant,secret=demo_thailand()
        stamp=str(int(time.time()))
        invoice=("VQ"+stamp+uuid.uuid4().hex[:6].upper())[:20]
        base="https://gpt-voxel-3d-staging-01.hjinffv5426.workers.dev"
        token=post_signed(TOKEN_URL,{
          "merchantID":merchant,"invoiceNo":invoice,"description":"VOXEL VIP PromptPay sandbox probe",
          "amount":50.00,"currencyCode":"THB","paymentChannel":["QR"],
          "nonceStr":uuid.uuid4().hex,
          "frontendReturnUrl":base+"/?payment=promptpay-return",
          "backendReturnUrl":base+"/payments/promptpay/backend"
        },secret)
        if token.get("respCode")!="0000" or not isinstance(token.get("paymentToken"),str):
            raise RuntimeError("payment-token-rejected:"+str(token.get("respCode","unknown")))
        payment=post_signed(PAY_URL,{
          "paymentToken":token["paymentToken"],
          "clientID":str(uuid.uuid4()),
          "locale":"th",
          "responseReturnUrl":base+"/?payment=promptpay-return",
          "payment":{"code":{"channelCode":"PPQR"},"data":{"name":"VOXEL TEST","email":"sandbox@example.invalid"}}
        },secret)
        if payment.get("respCode")!="1005":
            raise RuntimeError("promptpay-do-payment-rejected:"+str(payment.get("respCode","unknown")))
        if payment.get("channelCode")!="PPQR" or payment.get("type")!="URL":
            raise RuntimeError("unexpected-promptpay-response-shape")
        parsed=urlparse(payment.get("data") or "")
        allowed=parsed.scheme=="https" and (
          parsed.hostname=="pgw-static-sandbox.s3.amazonaws.com" or
          parsed.hostname=="api.2c2p.com" or
          (parsed.hostname or "").endswith(".2c2p.com"))
        if not allowed:
            raise RuntimeError("unexpected-qr-origin")
        report.update({"complete":True,"respCode":"1005","paymentTokenIssued":True,
          "dynamicQrIssued":True,"qrOrigin":parsed.hostname,"paymentExecuted":False})
        code=0
    except Exception as e:
        report["error"]=str(e)[:180]
        code=1
    with open(OUT,"w",encoding="utf-8") as f:
        json.dump(report,f,indent=2,sort_keys=True)
    print(json.dumps({k:v for k,v in report.items() if k!="error"},sort_keys=True))
    if code: print("PromptPay sandbox probe failed:",report["error"],file=sys.stderr)
    return code

if __name__=="__main__":
    sys.exit(main())
