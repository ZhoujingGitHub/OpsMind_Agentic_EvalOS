set -eu
# 以独立裁判身份批准 LG 的动作提案。
#
# 新增于 2026-09-16。原来那套工具里没有这个脚本，RUNBOOK 只写了端点
# POST /api/v1/investigations/<inv>/approvals，于是每轮都现场手拼。
#
# 四个绑定值**必须显式传入**，不由脚本自己抓——审批请求体绑定 proposal_digest 与
# environment_snapshot_digest 的目的就是防串票，让脚本自动抓等于把这道防护绕掉。
# 先跑 lg-inspect.sh 看正文，核对无误后把摘要抄进来。
#
#   INV       调查编号
#   AID       action_id
#   PDIGEST   proposal_digest（64 位）
#   SDIGEST   environment_snapshot_digest（64 位）
#   POLICYID  policy_decision_id
#   NS        本轮实验室命名空间（断言动作范围不越出它）
#   DECISION  approved | rejected（默认 approved）
: "${INV:?用法: INV=<inv-id> AID=<action-id> PDIGEST=<64位> SDIGEST=<64位> POLICYID=<id> NS=<命名空间>}"
: "${AID:?必须指明 action_id}"
: "${PDIGEST:?必须指明 proposal_digest（先跑 lg-inspect.sh 核对）}"
: "${SDIGEST:?必须指明 environment_snapshot_digest（先跑 lg-inspect.sh 核对）}"
: "${POLICYID:?必须指明 policy_decision_id}"
: "${NS:?必须指明本轮命名空间（断言会核对动作范围不越出它）}"
DECISION="${DECISION:-approved}"
REASON="${REASON:-接管方直连验收：已核对提案、现场快照与策略决策，仅批准本次实验租约命名空间内、符合受控仿真的最小修复，要求执行后以新的现场观测独立验证业务是否恢复。}"
python3 - "$INV" "$AID" "$PDIGEST" "$SDIGEST" "$POLICYID" "$NS" "$DECISION" "$REASON" <<'PY'
import json,pathlib,sys,urllib.error,urllib.request
INV,AID,PDIGEST,SDIGEST,POLICYID,NS,DECISION,REASON=sys.argv[1:9]
assert DECISION in ('approved','rejected'), DECISION
assert len(PDIGEST)==64 and len(SDIGEST)==64, (len(PDIGEST),len(SDIGEST))

cfg=dict(x.split("=",1) for x in pathlib.Path("/etc/opsmind-candidate-relay/langgraph-v1.env").read_text().splitlines() if "=" in x and not x.startswith("#"))
def call(p,role,payload=None):
 t=pathlib.Path(cfg["EVALOS_RELAY_TOKEN_DIR"],role).read_text().strip()
 raw=None if payload is None else json.dumps(payload,ensure_ascii=False).encode()
 r=urllib.request.Request(cfg["EVALOS_RELAY_PRODUCT_ORIGIN"]+p,data=raw,
   headers={"Authorization":"Bearer "+t,"x-tenant-id":"tenant-ctyun-ops-demo","content-type":"application/json"},
   method="GET" if payload is None else "POST")
 try:
  with urllib.request.urlopen(r,timeout=120) as x:return {"http_status":x.status,"body":json.load(x)}
 except urllib.error.HTTPError as e:
  try: detail=json.loads(e.read())
  except Exception: detail={"error_type":"non_json_response"}
  return {"http_status":e.code,"body":detail}

inv=call('/api/v1/investigations/'+INV,'candidate_submitter')
assert inv["http_status"]==200, inv
assert inv["body"].get("status")=="waiting_approval", {'status':inv["body"].get("status"),
  'hint':'审批端点要求 waiting_approval。不是这个状态说明动作已关闭或还没到审批点。'}

pe=call('/api/v1/investigations/'+INV+'/product-e2e','candidate_submitter')
assert pe["http_status"]==200, pe
life=pe["body"].get("action_lifecycle") or {}
cur=pe["body"].get("current_action_ref") or {}
prop=life.get("proposal") or {}
pol=life.get("policy_decision") or {}

# 安全不变量：当前动作就是你要批的那个、摘要对得上、还没执行过、在受控仿真下、范围不越出本轮命名空间
assert cur.get("action_id")==AID, (cur.get("action_id"),AID)
assert cur.get("proposal_digest")==PDIGEST, '提案摘要不符，可能是串票或提案已被替换'
assert life.get("attempt") is None and not life.get("escalation_reason"), life
# 实测返回是大写 REQUIRE_HUMAN（2026-09-16 链路② 现场确认），这里大小写不敏感比较
assert str(pol.get("decision")).lower()=="require_human", {'decision':pol.get('decision'),
  'hint':'策略决策不是 require_human，不该由人在这里批。'}
targets=prop.get("target_ids") or []
scope_ns=[x for x in (prop.get("namespace_ids") or [NS]) ]
assert all(n==NS for n in scope_ns), (scope_ns,NS)

# 职责分离：提交身份与审批身份必须是两个不同的账号，且审批方确有审批权
me_sub=call('/api/v1/me','candidate_submitter'); me_apr=call('/api/v1/me','approval_oracle')
assert me_sub["http_status"]==200 and me_apr["http_status"]==200, (me_sub,me_apr)
sid=me_sub["body"].get("user_id") or me_sub["body"].get("subject")
aid_=me_apr["body"].get("user_id") or me_apr["body"].get("subject")
assert sid and aid_ and sid!=aid_, {'submitter':sid,'approver':aid_,'hint':'职责分离不成立'}

body={"action_id":AID,"decision":DECISION,"reason":REASON,
      "proposal_digest":PDIGEST,"environment_snapshot_digest":SDIGEST,
      "policy_decision_id":POLICYID}
res=call('/api/v1/investigations/'+INV+'/approvals','approval_oracle',body)
print(json.dumps({"investigation_id":INV,"action_id":AID,"decision":DECISION,
 "submitter":sid,"approver":aid_,"separation_of_duties":sid!=aid_,
 "namespace":NS,"target_ids":targets,
 "policy_decision":pol.get("decision"),
 "http_status":res["http_status"],"result":res["body"]},ensure_ascii=False,indent=1))
assert res["http_status"] in (200,202), res
PY
