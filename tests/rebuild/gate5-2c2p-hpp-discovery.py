#!/usr/bin/env python3
import base64, hashlib, hmac, json, re, time, urllib.request
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright

DOC_URL="https://developer.2c2p.com/v4.0.2/docs/sandbox.md"
API_URL="https://sandbox-pgw.2c2p.com/payment/4.5/paymentToken"
OUT="work/gate5/hpp-discovery.json"

def b64u(b): return base64.urlsafe_b64encode(b).rstrip(b"=").decode()
def sign(payload,secret):
  h=b64u(b'{"alg":"HS256","typ":"JWT"}'); p=b64u(json.dumps(payload,separators=(",",":")).encode())
  s=b64u(hmac.new(secret.encode(),f"{h}.{p}".encode(),hashlib.sha256).digest()); return f"{h}.{p}.{s}"
def verify(token,secret):
  a,b,c=token.split("."); sig=base64.urlsafe_b64decode(c+"="*(-len(c)%4))
  if not hmac.compare_digest(sig,hmac.new(secret.encode(),f"{a}.{b}".encode(),hashlib.sha256).digest()): raise RuntimeError("bad-signature")
  return json.loads(base64.urlsafe_b64decode(b+"="*(-len(b)%4)))
def get(url):
  q=urllib.request.Request(url,headers={"User-Agent":"VOXEL-Gate5-HPP-Discovery/1.0"})
  with urllib.request.urlopen(q,timeout=20) as r: return r.read(2_000_000).decode("utf-8","replace")
def post(url,body):
  q=urllib.request.Request(url,data=json.dumps(body).encode(),method="POST",headers={"Content-Type":"application/json","User-Agent":"VOXEL-Gate5-HPP-Discovery/1.0"})
  with urllib.request.urlopen(q,timeout=20) as r: return json.loads(r.read(100_000).decode())
def credential():
  t=get(DOC_URL); i=t.upper().find("THAILAND")
  if i<0: raise RuntimeError("demo-not-found")
  w=t[i:i+12000]; m=re.search(r"JT04",w); k=re.search(r"\b[A-Fa-f0-9]{64}\b",w)
  if not m or not k: raise RuntimeError("demo-format-not-found")
  return "JT04",k.group(0)
def token_url():
  merchant,secret=credential(); stamp=str(int(time.time())); now=time.gmtime(); day=min(max(now.tm_mday,1),28)
  payload={"merchantID":merchant,"invoiceNo":("VH"+stamp)[-20:],"description":"VOXEL VIP sandbox UI discovery",
    "amount":50,"currencyCode":"THB","paymentChannel":["CC"],"recurring":True,
    "invoicePrefix":("VHR"+stamp)[-15:],"recurringAmount":50,"allowAccumulate":False,
    "maxAccumulateAmount":0,"recurringCount":0,"chargeOnDate":f"{day:02d}{now.tm_mon:02d}"}
  env=post(API_URL,{"payload":sign(payload,secret)}); data=verify(env["payload"],secret)
  if data.get("respCode")!="0000": raise RuntimeError("token-rejected")
  return data["webPaymentUrl"]

def clean(s,n=100): return re.sub(r"\s+"," ",str(s or "")).strip()[:n]

def main():
  import os; os.makedirs("work/gate5",exist_ok=True)
  report={"complete":False,"environment":"sandbox","secretRecorded":False,"tokenRecorded":False}
  try:
    url=token_url(); p=urlparse(url)
    if p.netloc!="sandbox-pgw-ui.2c2p.com": raise RuntimeError("unexpected-hpp-origin")
    with sync_playwright() as pw:
      browser=pw.chromium.launch(headless=True)
      page=browser.new_page(viewport={"width":1280,"height":900})
      page.goto(url,wait_until="networkidle",timeout=45000)
      inputs=page.locator("input").evaluate_all("""els => els.slice(0,30).map(e => ({
        type:e.type||'',name:e.name||'',placeholder:e.placeholder||'',
        aria:e.getAttribute('aria-label')||'',autocomplete:e.autocomplete||''
      }))""")
      buttons=page.locator("button").all_inner_texts()[:20]
      labels=page.locator("label").all_inner_texts()[:30]
      frames=[urlparse(f.url).netloc for f in page.frames if f.url and f.url!="about:blank"]
      report.update({"complete":True,"title":clean(page.title()),"hppOrigin":"https://sandbox-pgw-ui.2c2p.com",
        "inputMeta":[{k:clean(v,80) for k,v in x.items()} for x in inputs],
        "buttons":[clean(x,80) for x in buttons if clean(x,80)],
        "labels":[clean(x,80) for x in labels if clean(x,80)],
        "frameHosts":sorted(set(frames))})
      browser.close()
  except Exception as e: report["error"]=clean(type(e).__name__+":"+str(e),160)
  with open(OUT,"w",encoding="utf-8") as f: json.dump(report,f,indent=2,sort_keys=True)
  print(json.dumps({"complete":report["complete"],"environment":"sandbox","secretRecorded":False,"tokenRecorded":False}))
  return 0 if report["complete"] else 1
if __name__=="__main__": raise SystemExit(main())
