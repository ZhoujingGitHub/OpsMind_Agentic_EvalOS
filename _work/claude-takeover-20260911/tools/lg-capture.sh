set -eu
python3 - <<'PY'
import json,pathlib,urllib.request,datetime
cfg=dict(x.split("=",1) for x in pathlib.Path("/etc/opsmind-candidate-relay/langgraph-v1.env").read_text().splitlines() if "=" in x and not x.startswith("#"))
t=pathlib.Path(cfg["EVALOS_RELAY_TOKEN_DIR"],"candidate_submitter").read_text().strip()
def get(p):
 r=urllib.request.Request(cfg["EVALOS_RELAY_PRODUCT_ORIGIN"]+p,headers={"Authorization":"Bearer "+t,"x-tenant-id":"tenant-ctyun-ops-demo"})
 with urllib.request.urlopen(r,timeout=90) as x:return json.load(x)
INV='inv-f3b024e29c6940149d5cf98b'
pe=get('/api/v1/investigations/'+INV+'/product-e2e')
life=pe['action_lifecycle']; prop=life.get('proposal') or {}; snap=life.get('environment_snapshot') or {}; pol=life.get('policy_decision') or {}
rd=pe.get('repair_delivery') or {}
print(json.dumps({'captured_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),
 'status':pe.get('status'),
 'POLICY':{'decision':pol.get('decision'),'reason_codes':pol.get('reason_codes'),
   'public_reason':pol.get('public_reason'),'decided_at':pol.get('decided_at')},
 'SNAPSHOT':{'fault_still_present':snap.get('fault_still_present'),'observed_at':snap.get('observed_at'),
   'snapshot_id':snap.get('snapshot_id'),'resource_versions':list((snap.get('resource_versions') or {}).keys())},
 'BLOCKED_PROPOSAL':{'action_id':prop.get('action_id'),'action_type':prop.get('action_type'),
   'target_ids':prop.get('target_ids'),'risk_level':prop.get('risk_level'),
   'impact_summary':(prop.get('impact_summary') or '')[:500],
   'verification_plan':(prop.get('verification_plan') or '')[:400]},
 'REPAIR_DELIVERY':{'recovery_verified':rd.get('recovery_verified'),
   'final_action_ref':rd.get('final_action_ref'),'attempt_count':rd.get('attempt_count'),
   'explanation':rd.get('explanation'),
   'actions':[{k:a.get(k) for k in ('action_id','execution_status','changed_external_state')}|{'verification_outcome':(a.get('verification') or {}).get('outcome')} for a in (rd.get('actions') or [])]},
 'action_history':pe.get('action_history'),
 'current_action_ref':pe.get('current_action_ref'),
 'root_cause':pe.get('root_cause'),'root_cause_confidence':pe.get('root_cause_confidence'),
 'evidence_gate_status':(pe.get('evidence_gate') or {}).get('status')},ensure_ascii=False,indent=1))
PY
