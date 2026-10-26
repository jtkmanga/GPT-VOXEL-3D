#!/usr/bin/env python3
import base64, hashlib, hmac, json, re, urllib.request, uuid
from urllib.parse import urlparse

DOC_URL="https://developer.2c2p.com/v4.0.2/docs/sandbox.md"
TOKEN_URL="https://sandbox-pgw.2c2p.com/payment/4.5/paymentToken"
DETAILS_URL="https://sandbox-pgw.2c2p.com/payment/4.5/paymentOptionDetails"

def b64u(data): return base64.urlsafe_b64encode(data).rstrip(b"=").decode()
def sign(payload,secret):
    h=b64u(b'{"alg":"HS256","typ":"JWT"}')
    p=b64u(json.dumps(payload,separators=(",",":")).encode())
    s=(h+"."+p).encode()
    return h+"."+p+"."+b64u(hmac.new(secret.encode(),s,hashlib.sha256).digest())
def verify(token,secret):
    a=token.split(".")
    if len(a)!=3: raise RuntimeError("invalid-jwt")
    signed=(a[0]+"."+a[1]).encode()
    actual=base64.urlsafe_b64decode(a[2]+"="*(-len(a[2])%4))
    expected=hmac.new(secret.encode(),signed,hashlib.sha256).digest()
    if not hmac.compare_digest(actual,expected): raise RuntimeError("invalid-signature")
    return json.loads(base64.urlsafe_b64decode(a[1]+"="*(-len(a[1])%4)))
def creds():
    req=urllib.request.Request(DOC_URL,headers={"User-Agent":"VOXEL-PPQR-Details/1.0"})
    with urllib.request.urlopen(req,timeout=20) as r: text=r.read(2_000_000).decode("utf-8","replace")
    pos=text.upper().find("THAILAND")
    window=text[pos:pos+12000]
    return "JT04",re.search(r"\b[A-Fa-f0-9]{64}\b",window).group(0)
def post(url,payload,secret):
    req=urllib.request.Request(url,data=json.dumps({"payload":sign(payload,secret)}).encode(),method="POST",
      headers={"Content-Type":"application/json","User-Agent":"VOXEL-PPQR-Details/1.0"})
    with urllib.request.urlopen(req,timeout=20) as r:
        final=urlparse(r.geturl())
        if final.scheme!="https" or final.hostname!="sandbox-pgw.2c2p.com":
            raise RuntimeError("unexpected-api-origin")
        data=json.loads(r.read(200_000).decode())
    if isinstance(data,dict) and isinstance(data.get("payload"),str):
        return verify(data["payload"],secret)
    return data

def main():
    merchant,secret=creds()
    token=post(TOKEN_URL,{
      "merchantID":merchant,
      "invoiceNo":("VD"+uuid.uuid4().hex.upper())[:20],
      "description":"VOXEL PromptPay option details",
      "amount":50.0,
      "currencyCode":"THB",
      "nonceStr":str(uuid.uuid4()),
      "paymentChannel":["QR"]
    },secret)
    if token.get("respCode")!="0000" or not isinstance(token.get("paymentToken"),str):
        raise SystemExit("token-failed:"+str(token.get("respCode","none")))
    details=post(DETAILS_URL,{
      "paymentToken":token["paymentToken"],
      "clientID":str(uuid.uuid4()),
      "locale":"th",
      "categoryCode":"QR",
      "groupCode":"THQR"
    },secret)
    safe={"respCode":str(details.get("respCode","none")),
          "categoryCode":details.get("categoryCode"),
          "groupCode":details.get("groupCode"),
          "channels":[]}
    for channel in details.get("channels") or []:
        payment=channel.get("payment") or {}
        code=payment.get("code") or {}
        if code.get("channelCode")!="PPQR": continue
        inp=payment.get("input") or {}
        validation=payment.get("validation") or {}
        safe["channels"].append({
          "channelCode":code.get("channelCode"),
          "isDown":bool(channel.get("isDown")),
          "input":{str(k):str(v)[:16] for k,v in inp.items()},
          "validationKeys":sorted(str(k) for k in validation.keys())
        })
    print(json.dumps(safe,sort_keys=True))
    if safe["respCode"]!="0000" or not safe["channels"]:
        raise SystemExit(1)

if __name__=="__main__": main()
