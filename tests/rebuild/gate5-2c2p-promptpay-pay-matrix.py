#!/usr/bin/env python3
import base64, hashlib, hmac, json, re, urllib.request, uuid

DOC_URL="https://developer.2c2p.com/v4.0.2/docs/sandbox.md"
TOKEN_URL="https://sandbox-pgw.2c2p.com/payment/4.5/paymentToken"
PAY_URL="https://sandbox-pgw.2c2p.com/payment/4.5/payment"

def b64u(data): return base64.urlsafe_b64encode(data).rstrip(b"=").decode()
def sign(payload,secret):
    h=b64u(b'{"alg":"HS256","typ":"JWT"}')
    p=b64u(json.dumps(payload,separators=(",",":")).encode())
    raw=(h+"."+p).encode()
    return h+"."+p+"."+b64u(hmac.new(secret.encode(),raw,hashlib.sha256).digest())
def verify(token,secret):
    a=token.split(".")
    raw=(a[0]+"."+a[1]).encode()
    actual=base64.urlsafe_b64decode(a[2]+"="*(-len(a[2])%4))
    expected=hmac.new(secret.encode(),raw,hashlib.sha256).digest()
    if len(a)!=3 or not hmac.compare_digest(actual,expected): raise RuntimeError("invalid-jwt")
    return json.loads(base64.urlsafe_b64decode(a[1]+"="*(-len(a[1])%4)))
def creds():
    req=urllib.request.Request(DOC_URL,headers={"User-Agent":"VOXEL-PPQR-PayMatrix/1.0"})
    with urllib.request.urlopen(req,timeout=20) as r: text=r.read(2_000_000).decode("utf-8","replace")
    pos=text.upper().find("THAILAND"); window=text[pos:pos+12000]
    return "JT04",re.search(r"\b[A-Fa-f0-9]{64}\b",window).group(0)
def post(url,payload,secret):
    req=urllib.request.Request(url,data=json.dumps({"payload":sign(payload,secret)}).encode(),method="POST",
      headers={"Content-Type":"application/json","User-Agent":"VOXEL-PPQR-PayMatrix/1.0"})
    with urllib.request.urlopen(req,timeout=20) as r: data=json.loads(r.read(100_000).decode())
    if isinstance(data,dict) and isinstance(data.get("payload"),str): return verify(data["payload"],secret)
    return data
def token(merchant,secret):
    return post(TOKEN_URL,{
      "merchantID":merchant,"invoiceNo":("VP"+uuid.uuid4().hex.upper())[:20],
      "description":"VOXEL PPQR pay matrix","amount":10.0,"currencyCode":"THB",
      "paymentChannel":["QR"]
    },secret)
def main():
    merchant,secret=creds()
    variants=[
      ("base",False,False,True),
      ("qrtype",False,True,True),
      ("clientip",True,False,True),
      ("clientip-qrtype",True,True,True),
      ("clientip-emptydata",True,False,False)
    ]
    out=[]
    for name,use_ip,use_qrtype,use_contact in variants:
        t=token(merchant,secret)
        if t.get("respCode")!="0000" or not isinstance(t.get("paymentToken"),str):
            out.append({"variant":name,"tokenCode":str(t.get("respCode","none"))}); continue
        data={}
        if use_contact: data.update({"name":"VOXEL TEST","email":"sandbox@example.invalid"})
        if use_qrtype: data["qrType"]="URL"
        payload={"paymentToken":t["paymentToken"],"clientID":str(uuid.uuid4()),"locale":"th",
          "payment":{"code":{"channelCode":"PPQR"},"data":data}}
        if use_ip: payload["clientIP"]="175.144.230.170"
        p=post(PAY_URL,payload,secret)
        out.append({"variant":name,"tokenCode":"0000","respCode":str(p.get("respCode","none")),
          "channelCode":p.get("channelCode"),"type":p.get("type"),
          "respDesc":re.sub(r"[^A-Za-z0-9 _.,:()/-]","",str(p.get("respDesc","")))[:100]})
    print(json.dumps(out,sort_keys=True))
if __name__=="__main__": main()
