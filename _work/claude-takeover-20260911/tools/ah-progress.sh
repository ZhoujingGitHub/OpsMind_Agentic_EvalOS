set -eu
python3 - <<'PY'
import json,pathlib,urllib.request,datetime
cfg=dict(l.split('=',1) for l in pathlib.Path('/etc/opsmind-candidate-relay/agent-harness-v2.env').read_text().splitlines() if '=' in l and not l.startswith('#'))
token=pathlib.Path(cfg['EVALOS_RELAY_TOKEN_DIR'],'candidate_submitter').read_text().strip()
def get(p):
 r=urllib.request.Request(cfg['EVALOS_RELAY_PRODUCT_ORIGIN']+p,headers={'Authorization':'Bearer '+token,'x-tenant-id':'tenant-ctyun-ops-demo'})
 with urllib.request.urlopen(r,timeout=60) as x:return json.load(x)
inv='inv-608b343f5330'
d=get('/v2/investigations/'+inv)
rd=d.get('repair_delivery') or {}
out={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'status':d.get('status'),
 'phase':d.get('phase'),'trial':(d.get('run_context') or {}).get('trial_id'),
 'usage':d.get('budget_usage') or d.get('usage'),
 'pending_approval':rd.get('pending'),
 'actions':[{k:a.get(k) for k in ('action_id','approval_status','execution_status','business_status')} for a in rd.get('actions',[])],
 'has_report':bool(d.get('report'))}
print(json.dumps(out,ensure_ascii=False))
PY
