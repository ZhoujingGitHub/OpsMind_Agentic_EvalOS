set -eu
python3 - <<'PY'
import json,pathlib,urllib.request
cfg=dict(l.split('=',1) for l in pathlib.Path('/etc/opsmind-candidate-relay/agent-harness-v2.env').read_text().splitlines() if '=' in l and not l.startswith('#'))
t=pathlib.Path(cfg['EVALOS_RELAY_TOKEN_DIR'],'candidate_submitter').read_text().strip()
def get(p):
 r=urllib.request.Request(cfg['EVALOS_RELAY_PRODUCT_ORIGIN']+p,headers={'Authorization':'Bearer '+t,'x-tenant-id':'tenant-ctyun-ops-demo'})
 with urllib.request.urlopen(r,timeout=60) as x:return json.load(x)
d=get('/v2/investigations/inv-608b343f5330')
print('TOP KEYS:',sorted(d.keys()))
print('status=',d.get('status'))
for k in ('failure_reason','error','error_type','failure','termination_reason','status_reason','last_error'):
    if k in d: print(k,'=',json.dumps(d[k],ensure_ascii=False)[:600])
rep=d.get('report') or {}
print('REPORT KEYS:',sorted(rep.keys()))
print('report.delivery_receipt=',json.dumps(rep.get('delivery_receipt'),ensure_ascii=False)[:400])
print('report.root_cause=',json.dumps(rep.get('root_cause'),ensure_ascii=False)[:600])
print('report.confidence=',rep.get('confidence'))
rd=d.get('repair_delivery') or {}
a=(rd.get('actions') or [{}])[0]
print('ACTION:',json.dumps({k:a.get(k) for k in ('action_id','approval_status','execution_status','business_status','verified_at')},ensure_ascii=False))
print('business_verification=',json.dumps(a.get('business_verification'),ensure_ascii=False)[:900])
print('verification_source=',json.dumps(a.get('verification_source'),ensure_ascii=False)[:300])
PY
