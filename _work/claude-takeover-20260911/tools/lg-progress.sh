set -eu
# 轮询 LG 直连调查的进展（含策略决策、现场快照、动作生命周期）。
# 参数化于 2026-09-16：原先把 09-11 的调查编号写死，会不报错地返回那一次的状态。
: "${INV:?用法: INV=<inv-id> （无默认值）}"
python3 - "$INV" <<'PY'
import datetime,json,pathlib,sys,urllib.request
INV=sys.argv[1]
cfg=dict(x.split("=",1) for x in pathlib.Path("/etc/opsmind-candidate-relay/langgraph-v1.env").read_text().splitlines() if "=" in x and not x.startswith("#"))
t=pathlib.Path(cfg["EVALOS_RELAY_TOKEN_DIR"],"candidate_submitter").read_text().strip()
def get(p):
 r=urllib.request.Request(cfg["EVALOS_RELAY_PRODUCT_ORIGIN"]+p,headers={"Authorization":"Bearer "+t,"x-tenant-id":"tenant-ctyun-ops-demo"})
 with urllib.request.urlopen(r,timeout=120) as x:return json.load(x)
d=get('/api/v1/investigations/'+INV)
pe=get('/api/v1/investigations/'+INV+'/product-e2e')
life=pe.get('action_lifecycle') or {}
rd=pe.get('repair_delivery') or {}
print(json.dumps({'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'investigation_id':INV,
 'status':pe.get('status'),'phase':d.get('phase'),
 'current_action':(pe.get('current_action_ref') or {}).get('action_id'),
 'policy':(life.get('policy_decision') or {}).get('decision'),
 'policy_reasons':(life.get('policy_decision') or {}).get('reason_codes'),
 'fault_still_present':(life.get('environment_snapshot') or {}).get('fault_still_present'),
 'proposal':(life.get('proposal') or {}).get('action_type'),
 'attempt':(life.get('attempt') or {}).get('status'),
 'n_actions':len(rd.get('actions') or []),
 'recovery_verified':rd.get('recovery_verified'),
 'root_cause':pe.get('root_cause'),
 'budget':(pe.get('budget_usage') or {})},ensure_ascii=False))
PY
