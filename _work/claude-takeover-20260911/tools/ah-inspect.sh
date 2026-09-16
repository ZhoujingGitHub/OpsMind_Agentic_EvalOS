set -eu
# 看 AH 的动作提案：类型、参数、范围、回滚计划、策略有效期、两个摘要。审批前必看。
: "${AID:?用法: AID=<action-id> （无默认值）}"
python3 - "$AID" <<'PY'
import json,pathlib,sys,urllib.request
AID=sys.argv[1]
cfg=dict(l.split('=',1) for l in pathlib.Path('/etc/opsmind-candidate-relay/agent-harness-v2.env').read_text().splitlines() if '=' in l and not l.startswith('#'))
def call(p,role,body=None):
 t=pathlib.Path(cfg['EVALOS_RELAY_TOKEN_DIR'],role).read_text().strip()
 r=urllib.request.Request(cfg['EVALOS_RELAY_PRODUCT_ORIGIN']+p,data=None if body is None else json.dumps(body,ensure_ascii=False).encode(),
  headers={'Authorization':'Bearer '+t,'x-tenant-id':'tenant-ctyun-ops-demo','content-type':'application/json'},method='GET' if body is None else 'POST')
 with urllib.request.urlopen(r,timeout=90) as x:return json.load(x)
a=call('/v2/evaluation/actions/'+AID,'candidate_submitter')
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
