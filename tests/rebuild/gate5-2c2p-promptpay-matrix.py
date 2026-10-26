#!/usr/bin/env python3
import base64, hashlib, hmac, json, re, time, urllib.request, uuid
from urllib.parse import urlparse

DOC_URL="https://developer.2c2p.com/v4.0.2/docs/sandbox.md"
API_URL="https://sandbox-pgw.2c2p.com/payment/4.5/paymentToken"

def b64u(data): return base64.urlsafe_b64encode(data).rstrip(b"=").decode()
def sign(payload,secret):
    h=b64u(b'{"alg":"HS256","typ":"JWT"}')
    p=b64u(json.dumps(payload,separators=(",",":")).encode())
    s=(h+"."+p).encode()
    return h+"."+p+"."+b64u(hmac.new(secret.encode(),s,hashlib.sha256).digest())
def decode(token,secret):
    a=token.split(".")
    if len(a)!=3: return {"respCode":"invalid-jwt"}
    sig=base64.urlsafe_b64decode(a[2]+"="*(-len(a[2])%4))
    if not hmac.compare_digest(sig,hmac.new(secret.encode(),(a[0]+"."+a[1]).encode(),hashlib.sha256).digest()):
        return {"respCode":"invalid-signature"}
    return json.loads(base64.urlsafe_b64decode(a[1]+"="*(-len(a[1])%4)))
def creds():
    req=urllib.request.Request(DOC_URL,headers={"User-Agent":"VOXEL-PPQR-Matrix/1.0"})
    with urllib.request.urlopen(req,timeout=20) as r: text=r.read(2_000_000).decode("utf-8","replace")
    pos=text.upper().find("THAILAND"); window=text[pos:pos+12000]
    return "JT04",re.search(r"\b[A-Fa-f0-9]{64}\b",window).group(0)
def request(payload,secret):
    req=urllib.request.Request(API_URL,data=json.dumps({"payload":sign(payload,secret)}).encode(),method="POST",
      headers={"Content-Type":"application/json","User-Agent":"VOXEL-PPQR-Matrix/1.0"})
    with urllib.request.urlopen(req,timeout=20) as r: data=json.loads(r.read(100_000).decode())
    if isinstance(data,dict) and isinstance(data.get("payload"),str):
        result=decode(data["payload"],secret)
        return str(result.get("respCode","none")),str(result.get("respDesc",""))[:100]
    return str(data.get("respCode","none")),str(data.get("respDesc",""))[:100]

def main():
    merchant,secret=creds()
    base="https://gpt-voxel-3d-staging-01.hjinffv5426.workers.dev"
    variants=[
      ("docs-qr",["QR"],False),
      ("qr-return",["QR"],True),
      ("thqr-return",["THQR"],True),
      ("ppqr-return",["PPQR"],True)
    ]
    out=[]
    for i,(name,channels,with_return) in enumerate(variants):
        payload={"merchantID":merchant,
          "invoiceNo":("VM"+str(int(time.time()))+str(i)+uuid.uuid4().hex[:4].upper())[:20],
          "description":"VOXEL QR sandbox matrix","amount":10.0,"currencyCode":"THB",
          "nonceStr":str(uuid.uuid4()),"paymentChannel":channels}
        if with_return:
            payload.update({"frontendReturnUrl":base+"/?payment=promptpay-return",
              "backendReturnUrl":base+"/payments/promptpay/backend"})
        code,desc=request(payload,secret)
        out.append({"variant":name,"channels":channels,"returnUrls":with_return,
          "respCode":code,"respDesc":re.sub(r"[^A-Za-z0-9 _.,:()/-]","",desc)[:100]})
    print(json.dumps(out,sort_keys=True))
if __name__=="__main__": main()
