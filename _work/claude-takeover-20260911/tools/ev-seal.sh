set -eu
# 封存 EvalOS Trial 的全量证据（trial + trace + 账本）到服务器。
# 参数化于 2026-09-16：证据批次目录原先写死为 claude-takeover-20260911。
: "${TID:?用法: TID=<trial-id> TAG=<文件名前缀> BATCH=<证据批次目录名>}"
: "${TAG:?必须指明文件名前缀，例如 TAG=ah-chain3-evalos}"
: "${BATCH:?必须指明证据批次目录名}"
mkdir -p "/srv/opsmind-evidence/$BATCH"
python3 - "$TID" "$TAG" "$BATCH" <<'PY'
import gzip,hashlib,json,pathlib,sys,urllib.error,urllib.request
TID,TAG,BATCH=sys.argv[1:4]
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
out=pathlib.Path('/srv/opsmind-evidence/%s/%s-%s.json'%(BATCH,TAG,TID))
out.write_bytes(raw); gz=pathlib.Path(str(out)+'.gz'); gz.write_bytes(gzip.compress(raw))
g=(t.get('graders') or [{}])[0].get('result') or {}
print(json.dumps({'sealed':str(out),'bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest(),
 'n_trace':len(tr),'trial_id':TID,'total':g.get('total'),'passed':g.get('passed'),
 'qualification_passed':g.get('qualification_passed'),
 'dimensions':{k:{'n':round(v.get('normalized',0),4),'w':v.get('weight'),'s':round(v.get('weighted',0),3)} for k,v in (g.get('dimensions') or {}).items()},
 'ledger':bundle['overview_ledger'],
 'cleanup':t.get('cleanup_reconciliations'),
 'usage':(t.get('trial') or {}).get('usage')},ensure_ascii=False,indent=1))
PY
