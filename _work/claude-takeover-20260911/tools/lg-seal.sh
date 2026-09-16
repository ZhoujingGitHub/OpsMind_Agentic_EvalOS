set -eu
# 封存 LG 直连调查的全量证据到服务器，本地只留摘要。
# 参数化于 2026-09-16：原先调查编号、文件名前缀、证据批次目录三者全写死。
: "${INV:?用法: INV=<inv-id> TAG=<文件名前缀,如 lg-chain2> BATCH=<证据批次目录名>}"
: "${TAG:?必须指明文件名前缀，例如 TAG=lg-chain2}"
: "${BATCH:?必须指明证据批次目录名}"
mkdir -p "/srv/opsmind-evidence/$BATCH"
python3 - "$INV" "$TAG" "$BATCH" <<'PY'
import gzip,hashlib,json,pathlib,sys,urllib.request
INV,TAG,BATCH=sys.argv[1:4]
cfg=dict(x.split("=",1) for x in pathlib.Path("/etc/opsmind-candidate-relay/langgraph-v1.env").read_text().splitlines() if "=" in x and not x.startswith("#"))
t=pathlib.Path(cfg["EVALOS_RELAY_TOKEN_DIR"],"candidate_submitter").read_text().strip()
def get(p):
 r=urllib.request.Request(cfg["EVALOS_RELAY_PRODUCT_ORIGIN"]+p,headers={"Authorization":"Bearer "+t,"x-tenant-id":"tenant-ctyun-ops-demo"})
 with urllib.request.urlopen(r,timeout=120) as x:return json.load(x)
bundle={'investigation':get('/api/v1/investigations/'+INV),
        'product_e2e':get('/api/v1/investigations/'+INV+'/product-e2e')}
try:
    ev=[];cur=0
    while True:
        pg=get('/api/v1/investigations/%s/events?after=%d&limit=200'%(INV,cur))
        items=pg.get('items') or pg.get('events') or []
        ev.extend(items)
        if not items or not pg.get('has_more'): break
        cur=pg.get('cursor') or cur+len(items)
        if len(ev)>5000: break
    bundle['public_events']=ev
except Exception as e:
    bundle['public_events_error']=type(e).__name__
raw=json.dumps(bundle,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode()
out=pathlib.Path('/srv/opsmind-evidence/%s/%s-%s.json'%(BATCH,TAG,INV))
out.write_bytes(raw); gz=pathlib.Path(str(out)+'.gz'); gz.write_bytes(gzip.compress(raw))
pe=bundle['product_e2e']; tr=pe.get('task_result') or {}
rd=pe.get('repair_delivery') or {}
print(json.dumps({'sealed':str(out),'bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest(),
 'gz_bytes':gz.stat().st_size,'n_public_events':len(bundle.get('public_events') or []),
 'investigation_id':INV,'status':pe.get('status'),'archive_reconciled':pe.get('archive_reconciled'),
 'task_result_outcome':tr.get('outcome'),'root_cause':pe.get('root_cause'),
 'root_cause_confidence':pe.get('root_cause_confidence'),
 'evidence_gate':(pe.get('evidence_gate') or {}).get('status'),
 'recovery_verified':rd.get('recovery_verified'),'explanation':rd.get('explanation'),
 'n_actions':len(rd.get('actions') or []),
 'best_available_conclusion':(tr.get('best_available_conclusion') or '')[:600],
 'usage':pe.get('budget_usage')},ensure_ascii=False,indent=1))
PY
