set -eu
# 看 LG 待审批动作的全部审批上下文：提案、现场快照、策略决策，以及审批请求要绑定的
# 三个标识（action_id / proposal_digest / environment_snapshot_digest / policy_decision_id）。
#
# 新增于 2026-09-16。原来那套工具里**没有 LG 的审批脚本**，RUNBOOK 只写了端点地址，
# 于是每轮都要现场翻响应结构。审批前必须用它核对，再把摘要显式传给 lg-approve.sh。
: "${INV:?用法: INV=<inv-id>}"
python3 - "$INV" <<'PY'
import json,pathlib,sys,urllib.request
INV=sys.argv[1]
cfg=dict(x.split("=",1) for x in pathlib.Path("/etc/opsmind-candidate-relay/langgraph-v1.env").read_text().splitlines() if "=" in x and not x.startswith("#"))
t=pathlib.Path(cfg["EVALOS_RELAY_TOKEN_DIR"],"candidate_submitter").read_text().strip()
def get(p):
 r=urllib.request.Request(cfg["EVALOS_RELAY_PRODUCT_ORIGIN"]+p,headers={"Authorization":"Bearer "+t,"x-tenant-id":"tenant-ctyun-ops-demo"})
 with urllib.request.urlopen(r,timeout=90) as x:return json.load(x)

inv=get('/api/v1/investigations/'+INV)
pe=get('/api/v1/investigations/'+INV+'/product-e2e')
life=pe.get('action_lifecycle') or {}
cur=pe.get('current_action_ref') or {}

print('investigation_id =',INV)
print('investigation.status =',inv.get('status'),'  （审批端点要求 waiting_approval）')
print('product_e2e.status  =',pe.get('status'))
print()
print('=== current_action_ref（审批要绑定的标识都在这里或 lifecycle 里）===')
print(json.dumps(cur,ensure_ascii=False,indent=1))
print()
print('=== 提案 ===')
print(json.dumps(life.get('proposal'),ensure_ascii=False,indent=1)[:2500])
print()
print('=== 现场快照 ===')
print(json.dumps(life.get('environment_snapshot'),ensure_ascii=False,indent=1)[:1800])
print()
print('=== 策略决策 ===')
print(json.dumps(life.get('policy_decision'),ensure_ascii=False,indent=1)[:1500])
print()
print('=== 执行尝试 / 升级原因（都必须为空才是待审批）===')
print('attempt =',json.dumps(life.get('attempt'),ensure_ascii=False)[:300])
print('escalation_reason =',json.dumps(life.get('escalation_reason'),ensure_ascii=False)[:300])
print()
print('=== 传给 lg-approve.sh 的四个值（自动摘出，仍请与上面正文核对）===')
snap=life.get('environment_snapshot') or {}
pol=life.get('policy_decision') or {}
prop=life.get('proposal') or {}
cand={'AID':cur.get('action_id') or prop.get('action_id'),
      'PDIGEST':cur.get('proposal_digest') or prop.get('proposal_digest'),
      'SDIGEST':snap.get('snapshot_digest') or snap.get('environment_snapshot_digest') or snap.get('digest'),
      'POLICYID':pol.get('policy_decision_id') or pol.get('decision_id') or pol.get('id')}
for k,v in cand.items():
    print('  %-9s = %s' % (k, v if v else '!! 没摘到，去上面正文里找准确字段名'))
PY
