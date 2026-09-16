set -eu
# 看 AH 调查的报告、根因、动作与业务验证细节。
# 参数化于 2026-09-16：原先把 09-11 的调查编号写死在脚本里，会**不报错**地返回那一次的状态。
: "${INV:?用法: INV=<inv-id> （无默认值，必须指明这一次的调查编号）}"
python3 - "$INV" <<'PY'
import collections,json,pathlib,sys,urllib.request,hashlib,base64,gzip,datetime
INV=sys.argv[1]
cfg=dict(l.split('=',1) for l in pathlib.Path('/etc/opsmind-candidate-relay/agent-harness-v2.env').read_text().splitlines() if '=' in l and not l.startswith('#'))
t=pathlib.Path(cfg['EVALOS_RELAY_TOKEN_DIR'],'candidate_submitter').read_text().strip()
def get(p):
 r=urllib.request.Request(cfg['EVALOS_RELAY_PRODUCT_ORIGIN']+p,headers={'Authorization':'Bearer '+t,'x-tenant-id':'tenant-ctyun-ops-demo'})
 with urllib.request.urlopen(r,timeout=90) as x:return json.load(x)
d=get('/v2/investigations/'+INV)
print('INVESTIGATION:',INV)
print('TOP KEYS:',sorted(d.keys()))
print('status=',d.get('status'))
for k in ('failure_reason','error','error_type','failure','termination_reason','status_reason','last_error'):
    if k in d: print(k,'=',json.dumps(d[k],ensure_ascii=False)[:600])
rep=d.get('report') or {}
print('REPORT KEYS:',sorted(rep.keys()))
print('report.delivery_receipt=',json.dumps(rep.get('delivery_receipt'),ensure_ascii=False)[:400])
print('report.root_cause=',json.dumps(rep.get('root_cause'),ensure_ascii=False)[:600])
print('report.confidence=',rep.get('confidence'))
rd=d.get('repair_delivery') or {}
a=(rd.get('actions') or [{}])[0]
print('ACTION:',json.dumps({k:a.get(k) for k in ('action_id','approval_status','execution_status','business_status','verified_at')},ensure_ascii=False))
print('business_verification=',json.dumps(a.get('business_verification'),ensure_ascii=False)[:900])
print('verification_source=',json.dumps(a.get('verification_source'),ensure_ascii=False)[:300])
PY
