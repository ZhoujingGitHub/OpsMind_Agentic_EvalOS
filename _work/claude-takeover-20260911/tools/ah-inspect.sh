set -eu
# 看 AH 的动作提案：类型、参数、范围、风险档、举证链接、回滚计划、验证计划、策略有效期、两个摘要。
# 审批前必看——ah-approve.sh 只核对不变量（租约/隔离/职责分离/未过期），**不核对这个动作治的是什么**，
# 那一半只能靠人读这里的输出。
#
# 2026-09-18 修正：原来读的是 /v2/evaluation/actions/{id}。
# 那是**考试作答端点**，`evaluation_answer()` 故意只返回 proposal_version / proposal_digest /
# action_type / action_version / target_entity_id / scope / parameters —— 脱敏是对的，
# 不能让考生从作答接口反查自己的完整提案。两个角色（candidate_submitter / approval_oracle）拿到的
# 都是同一份脱敏视图，实测已确认。
# 结果是本脚本长期把 risk / justification / rollback / verification_plan 打成 null 或空串，
# 会让人误判 AH 的提案没有回滚计划和验证计划——实际上都有。
# 运维视角的完整记录在 /v2/actions/{id}（main.py 的 action_detail -> detail()），41 个字段。
# **不要改回 evaluation 端点。**
: "${AID:?用法: AID=<action-id> （无默认值）}"
python3 - "$AID" <<'PY'
import json,pathlib,sys,urllib.request
AID=sys.argv[1]
cfg=dict(l.split('=',1) for l in pathlib.Path('/etc/opsmind-candidate-relay/agent-harness-v2.env').read_text().splitlines() if '=' in l and not l.startswith('#'))
def get(p,role):
 t=pathlib.Path(cfg['EVALOS_RELAY_TOKEN_DIR'],role).read_text().strip()
 r=urllib.request.Request(cfg['EVALOS_RELAY_PRODUCT_ORIGIN']+p,
  headers={'Authorization':'Bearer '+t,'x-tenant-id':'tenant-ctyun-ops-demo'})
 with urllib.request.urlopen(r,timeout=90) as x:return json.load(x)
# 以审批人身份读，因为这份输出就是给审批人看的。
a=get('/v2/actions/'+AID,'approval_oracle')
pol=a.get('policy_decision') or a.get('precheck_json') or {}
snap=a.get('environment_snapshot') or {}
out={
 'action_id':a.get('action_id'),'investigation_id':a.get('investigation_id'),'trial_id':a.get('trial_id'),
 'status':a.get('status'),
 'action_type':a.get('action_type'),'action_version':a.get('action_version'),
 'target_entity_id':a.get('target_entity_id'),
 'parameters':a.get('parameters_json'),
 'scope':a.get('scope_json'),
 'risk_level':a.get('risk_level'),
 # 举证链接（2026-09-18 迁移 018 新增）：这个动作治的是哪个假设、凭哪些证据、排除了哪些竞争机制。
 'target_hypothesis_id':a.get('target_hypothesis_id'),
 'supporting_evidence_ids':a.get('supporting_evidence_ids_json'),
 'alternatives_considered':a.get('alternatives_considered_json'),
 'justification':a.get('justification'),
 'rollback_plan':a.get('rollback_plan_json'),
 'verification_plan':a.get('verification_plan_json'),
 'proposal_digest':a.get('proposal_digest'),
 'snapshot_digest':snap.get('snapshot_digest') or a.get('environment_snapshot_id'),
 'idempotency_key':a.get('idempotency_key'),
 'operating_mode':a.get('operating_mode'),'execution_mode':a.get('execution_mode'),
 'production_execution':a.get('production_execution'),
 'policy':{k:pol.get(k) for k in ('decision','reason_code','execution_mode','valid_until')},
 'delivery':a.get('delivery'),
}
print(json.dumps(out,ensure_ascii=False,indent=1))
PY
