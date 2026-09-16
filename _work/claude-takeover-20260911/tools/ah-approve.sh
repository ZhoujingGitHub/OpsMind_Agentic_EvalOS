set -eu
python3 - <<'PY'
import json,pathlib,urllib.request
from datetime import datetime,timezone
cfg=dict(l.split('=',1) for l in pathlib.Path('/etc/opsmind-candidate-relay/agent-harness-v2.env').read_text().splitlines() if '=' in l and not l.startswith('#'))
def call(p,role,body=None):
 t=pathlib.Path(cfg['EVALOS_RELAY_TOKEN_DIR'],role).read_text().strip()
 r=urllib.request.Request(cfg['EVALOS_RELAY_PRODUCT_ORIGIN']+p,data=None if body is None else json.dumps(body,ensure_ascii=False).encode(),
  headers={'Authorization':'Bearer '+t,'x-tenant-id':'tenant-ctyun-ops-demo','content-type':'application/json'},method='GET' if body is None else 'POST')
 with urllib.request.urlopen(r,timeout=90) as x:return json.load(x)
AID='action-eee910c2614b'
a=call('/v2/evaluation/actions/'+AID,'candidate_submitter')
p=a['proposal']; s=p['scope']
# 安全不变量：全部在本次实验租约内、隔离实验室、非共享资源、受控仿真
assert a['investigation_id']=='inv-608b343f5330' and a['tenant_id']=='tenant-ctyun-ops-demo'
assert s['resource_ref']['namespace']=='ah-claude-takeover-20260911-01'
assert s['resource_ownership']=='trial_lease' and s['deployment_profile']=='ISOLATED_LAB' and s['shared_resource'] is False
assert a['policy_decision']['execution_mode']=='controlled_simulation'
assert a['final_status']=='human_required'
assert datetime.fromisoformat(a['policy_decision']['valid_until'])>datetime.now(timezone.utc)
sub=call('/v2/auth/me','candidate_submitter'); apr=call('/v2/auth/me','approval_oracle')
assert sub['user_id']!=apr['user_id'] and apr['permissions']['approve_action'] is True
resp=call('/v2/actions/'+AID+'/approval','approval_oracle',{'decision':'approved',
 'comment':'接管方直连验收：仅批准本次实验租约内、已核对提案与现场摘要的最小网络策略修复，要求执行后独立业务验证。',
 'proposal_digest':p['proposal_digest'],'snapshot_digest':a['environment_snapshot']['snapshot_digest'],
 'continue_execution':True})
print(json.dumps({'action_id':AID,'approved':True,'approver':apr['user_id'],'submitter':sub['user_id'],
 'separation_of_duties':sub['user_id']!=apr['user_id'],
 'execution_continuation':resp.get('execution_continuation'),'result':resp},ensure_ascii=False))
PY
