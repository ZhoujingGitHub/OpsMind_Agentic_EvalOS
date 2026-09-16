set -eu
mkdir -p /srv/opsmind-evidence/claude-takeover-20260911
python3 - "$TID" "$TAG" <<'PY'
import json,sys,urllib.request,urllib.error,pathlib,hashlib,gzip
TID,TAG=sys.argv[1:3]
def get(p):
 r=urllib.request.Request('http://127.0.0.1:3000'+p,headers={'content-type':'application/json'})
 try:
  with urllib.request.urlopen(r,timeout=120) as x:return json.load(x)
 except urllib.error.HTTPError as e: return {'__http':e.code}
t=get('/api/workbench/trials/'+TID)
tr=[];after=0
while True:
    pg=get('/api/workbench/trials/%s/trace?after=%d&limit=500'%(TID,after))
    items=pg.get('items') or []
    tr.extend(items)
    if not pg.get('has_more'): break
    after=pg.get('cursor') or after+len(items)
    if len(tr)>20000: break
bundle={'trial':t,'trace':tr,'overview_ledger':get('/api/workbench/overview').get('ledger')}
raw=json.dumps(bundle,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode()
out=pathlib.Path('/srv/opsmind-evidence/claude-takeover-20260911/%s-%s.json'%(TAG,TID))
out.write_bytes(raw); gz=pathlib.Path(str(out)+'.gz'); gz.write_bytes(gzip.compress(raw))
g=(t.get('graders') or [{}])[0].get('result') or {}
print(json.dumps({'sealed':str(out),'bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest(),
 'n_trace':len(tr),'total':g.get('total'),'passed':g.get('passed'),
 'qualification_passed':g.get('qualification_passed'),
 'dimensions':{k:{'n':round(v.get('normalized',0),4),'w':v.get('weight'),'s':round(v.get('weighted',0),3)} for k,v in (g.get('dimensions') or {}).items()},
 'ledger':bundle['overview_ledger'],
 'cleanup':t.get('cleanup_reconciliations'),
 'usage':(t.get('trial') or {}).get('usage')},ensure_ascii=False,indent=1))
PY
