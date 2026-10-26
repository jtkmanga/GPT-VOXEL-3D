#!/usr/bin/env python3
import base64, hashlib, hmac, json, re, urllib.request, uuid

DOC_URL="https://developer.2c2p.com/v4.0.2/docs/sandbox.md"
TOKEN_URL="https://sandbox-pgw.2c2p.com/payment/4.5/paymentToken"
OPTION_URL="https://sandbox-pgw.2c2p.com/payment/4.5/paymentOption"

def b64u(d): return base64.urlsafe_b64encode(d).rstrip(b"=").decode()
def sign(p,s):
    h=b64u(b'{"alg":"HS256","typ":"JWT"}'); b=b64u(json.dumps(p,separators=(",",":")).encode())
    raw=(h+"."+b).encode(); return h+"."+b+"."+b64u(hmac.new(s.encode(),raw,hashlib.sha256).digest())
def verify(t,s):
    a=t.split("."); raw=(a[0]+"."+a[1]).encode()
    if len(a)!=3 or not hmac.compare_digest(base64.urlsafe_b64decode(a[2]+"="*(-len(a[2])%4)),hmac.new(s.encode(),raw,hashlib.sha256).digest()):
        raise RuntimeError("invalid-jwt")
    return json.loads(base64.urlsafe_b64decode(a[1]+"="*(-len(a[1])%4)))
def creds():
    req=urllib.request.Request(DOC_URL,headers={"User-Agent":"VOXEL-PPQR-Options/1.0"})
    with urllib.request.urlopen(req,timeout=20) as r: text=r.read(2_000_000).decode("utf-8","replace")
    pos=text.upper().find("THAILAND"); w=text[pos:pos+12000]
    return "JT04",re.search(r"\b[A-Fa-f0-9]{64}\b",w).group(0)
def post(url,payload,secret):
    req=urllib.request.Request(url,data=json.dumps({"payload":sign(payload,secret)}).encode(),method="POST",
      headers={"Content-Type":"application/json","User-Agent":"VOXEL-PPQR-Options/1.0"})
    with urllib.request.urlopen(req,timeout=20) as r: data=json.loads(r.read(200_000).decode())
    if isinstance(data,dict) and isinstance(data.get("payload"),str): return verify(data["payload"],secret)
    return data
def main():
    m,s=creds()
    for scope in (["QR"],["THQR"],["PPQR"]):
        t=post(TOKEN_URL,{"merchantID":m,"invoiceNo":("VO"+uuid.uuid4().hex.upper())[:20],
          "description":"VOXEL options probe","amount":10.0,"currencyCode":"THB","paymentChannel":scope},s)
        out={"scope":scope,"tokenCode":str(t.get("respCode","none"))}
        if t.get("respCode")=="0000" and isinstance(t.get("paymentToken"),str):
            o=post(OPTION_URL,{"paymentToken":t["paymentToken"],"clientID":str(uuid.uuid4()),"locale":"th"},s)
            groups=[]
            for cat in o.get("channelCategories") or []:
                if cat.get("code")!="QR": continue
                groups=[str(g.get("code")) for g in cat.get("groups") or []]
            out.update({"optionCode":str(o.get("respCode","none")),"qrGroups":groups})
        print(json.dumps(out,sort_keys=True))
if __name__=="__main__": main()
