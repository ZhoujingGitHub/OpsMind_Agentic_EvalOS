set -eu
python3 - <<'PY'
import json,pathlib,urllib.request
cfg=dict(l.split('=',1) for l in pathlib.Path('/etc/opsmind-candidate-relay/agent-harness-v2.env').read_text().splitlines() if '=' in l and not l.startswith('#'))
def call(p,role,body=None):
 t=pathlib.Path(cfg['EVALOS_RELAY_TOKEN_DIR'],role).read_text().strip()
 r=urllib.request.Request(cfg['EVALOS_RELAY_PRODUCT_ORIGIN']+p,data=None if body is None else json.dumps(body,ensure_ascii=False).encode(),
  headers={'Authorization':'Bearer '+t,'x-tenant-id':'tenant-ctyun-ops-demo','content-type':'application/json'},method='GET' if body is None else 'POST')
 with urllib.request.urlopen(r,timeout=90) as x:return json.load(x)
a=call('/v2/evaluation/actions/action-eee910c2614b','candidate_submitter')
p=a['proposal']
print(json.dumps({'action_id':a['action_id'],'investigation_id':a['investigation_id'],'trial_id':a['trial_id'],
 'final_status':a.get('final_status'),'action_type':p.get('action_type'),'parameters':p.get('parameters'),
 'risk':p.get('risk_level'),'summary':(p.get('rationale') or p.get('impact_summary') or '')[:600],
 'scope':p.get('scope'),'rollback':p.get('rollback_plan'),
 'verification_plan':(p.get('verification_plan') or '')[:400],
 'proposal_digest':p.get('proposal_digest'),
 'snapshot_digest':a['environment_snapshot']['snapshot_digest'],
 'policy':{k:a['policy_decision'].get(k) for k in ('decision','execution_mode','valid_until','production_write_enabled')}},ensure_ascii=False,indent=1))
PY
