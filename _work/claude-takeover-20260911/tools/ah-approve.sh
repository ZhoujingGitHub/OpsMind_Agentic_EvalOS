set -eu
# 以独立裁判身份批准 AH 的动作提案。
#
# 参数化于 2026-09-16。**安全断言一条都没删**，只是把"期望值"从写死改成必须传入：
# 原先断言 investigation_id=='inv-608b343f5330'、namespace=='ah-claude-takeover-20260911-01'，
# 那是 09-11 那一轮的值，换一轮就必然失败——于是下一任会倾向于把断言删掉。
# 现在改成你必须自己说出这一轮的期望值，断言照旧执行。
: "${AID:?用法: AID=<action-id> INV=<inv-id> NS=<本轮 trial 命名空间> [COMMENT=...]}"
: "${INV:?必须指明本轮调查编号（断言会核对提案确实属于它）}"
: "${NS:?必须指明本轮 trial 命名空间（断言会核对动作范围不越出它）}"
COMMENT="${COMMENT:-接管方直连验收：仅批准本次实验租约内、已核对提案与现场摘要的最小网络策略修复，要求执行后独立业务验证。}"
python3 - "$AID" "$INV" "$NS" "$COMMENT" <<'PY'
import json,pathlib,sys,urllib.request
from datetime import datetime,timezone
AID,INV,NS,COMMENT=sys.argv[1:5]
cfg=dict(l.split('=',1) for l in pathlib.Path('/etc/opsmind-candidate-relay/agent-harness-v2.env').read_text().splitlines() if '=' in l and not l.startswith('#'))
def call(p,role,body=None):
 t=pathlib.Path(cfg['EVALOS_RELAY_TOKEN_DIR'],role).read_text().strip()
 r=urllib.request.Request(cfg['EVALOS_RELAY_PRODUCT_ORIGIN']+p,data=None if body is None else json.dumps(body,ensure_ascii=False).encode(),
  headers={'Authorization':'Bearer '+t,'x-tenant-id':'tenant-ctyun-ops-demo','content-type':'application/json'},method='GET' if body is None else 'POST')
 with urllib.request.urlopen(r,timeout=90) as x:return json.load(x)
a=call('/v2/evaluation/actions/'+AID,'candidate_submitter')
p=a['proposal']; s=p['scope']
# 安全不变量：全部在本次实验租约内、隔离实验室、非共享资源、受控仿真、职责分离、策略未过期
assert a['investigation_id']==INV, (a['investigation_id'],INV)
assert a['tenant_id']=='tenant-ctyun-ops-demo', a['tenant_id']
assert s['resource_ref']['namespace']==NS, (s['resource_ref']['namespace'],NS)
assert s['resource_ownership']=='trial_lease' and s['deployment_profile']=='ISOLATED_LAB' and s['shared_resource'] is False, s
assert a['policy_decision']['execution_mode']=='controlled_simulation', a['policy_decision']
assert a['final_status']=='human_required', a['final_status']
assert datetime.fromisoformat(a['policy_decision']['valid_until'])>datetime.now(timezone.utc), a['policy_decision']['valid_until']
sub=call('/v2/auth/me','candidate_submitter'); apr=call('/v2/auth/me','approval_oracle')
assert sub['user_id']!=apr['user_id'] and apr['permissions']['approve_action'] is True, (sub['user_id'],apr['user_id'])
resp=call('/v2/actions/'+AID+'/approval','approval_oracle',{'decision':'approved','comment':COMMENT,
 'proposal_digest':p['proposal_digest'],'snapshot_digest':a['environment_snapshot']['snapshot_digest'],
 'continue_execution':True})
print(json.dumps({'action_id':AID,'investigation_id':INV,'namespace':NS,'approved':True,
 'approver':apr['user_id'],'submitter':sub['user_id'],
 'separation_of_duties':sub['user_id']!=apr['user_id'],
 'execution_continuation':resp.get('execution_continuation'),'result':resp},ensure_ascii=False))
PY
