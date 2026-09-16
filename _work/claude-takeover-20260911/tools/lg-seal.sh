set -eu
mkdir -p /srv/opsmind-evidence/claude-takeover-20260911
python3 - <<'PY'
import json,pathlib,urllib.request,hashlib,gzip
cfg=dict(x.split("=",1) for x in pathlib.Path("/etc/opsmind-candidate-relay/langgraph-v1.env").read_text().splitlines() if "=" in x and not x.startswith("#"))
t=pathlib.Path(cfg["EVALOS_RELAY_TOKEN_DIR"],"candidate_submitter").read_text().strip()
def get(p):
 r=urllib.request.Request(cfg["EVALOS_RELAY_PRODUCT_ORIGIN"]+p,headers={"Authorization":"Bearer "+t,"x-tenant-id":"tenant-ctyun-ops-demo"})
 with urllib.request.urlopen(r,timeout=120) as x:return json.load(x)
INV='inv-f3b024e29c6940149d5cf98b'
bundle={'investigation':get('/api/v1/investigations/'+INV),
        'product_e2e':get('/api/v1/investigations/'+INV+'/product-e2e')}
try:
    ev=[];cur=0
    while True:
        pg=get('/api/v1/investigations/%s/events?after=%d&limit=200'%(INV,cur))
        items=pg.get('items') or pg.get('events') or []
        ev.extend(items)
        if not pg.get('has_more'): break
        cur=pg.get('cursor') or (cur+len(items))
        if len(ev)>5000: break
    bundle['public_events']=ev
except Exception as e:
    bundle['public_events_error']=type(e).__name__
raw=json.dumps(bundle,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode()
out=pathlib.Path('/srv/opsmind-evidence/claude-takeover-20260911/lg-chain2-%s.json'%INV)
out.write_bytes(raw); gz=pathlib.Path(str(out)+'.gz'); gz.write_bytes(gzip.compress(raw))
pe=bundle['product_e2e']; tr=pe.get('task_result') or {}
rd=pe.get('repair_delivery') or {}
print(json.dumps({'sealed':str(out),'bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest(),
 'gz_bytes':gz.stat().st_size,'n_public_events':len(bundle.get('public_events') or []),
 'status':pe.get('status'),'archive_reconciled':pe.get('archive_reconciled'),
 'task_result_outcome':tr.get('outcome'),'root_cause':pe.get('root_cause'),
 'root_cause_confidence':pe.get('root_cause_confidence'),
 'evidence_gate':(pe.get('evidence_gate') or {}).get('status'),
 'recovery_verified':rd.get('recovery_verified'),'explanation':rd.get('explanation'),
 'n_actions':len(rd.get('actions') or []),
 'best_available_conclusion':(tr.get('best_available_conclusion') or '')[:600],
 'usage':pe.get('budget_usage')},ensure_ascii=False,indent=1))
PY
