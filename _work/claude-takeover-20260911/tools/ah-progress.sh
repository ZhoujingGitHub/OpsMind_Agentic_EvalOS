set -eu
# 轮询 AH 直连调查的进展。建议 45-60 秒一次，放后台。
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
rd=d.get('repair_delivery') or {}
out={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'investigation_id':INV,
 'status':d.get('status'),'phase':d.get('phase'),'trial':(d.get('run_context') or {}).get('trial_id'),
 'usage':d.get('budget_usage') or d.get('usage'),
 'pending_approval':rd.get('pending'),
 'actions':[{k:a.get(k) for k in ('action_id','approval_status','execution_status','business_status')} for a in rd.get('actions',[])],
 'has_report':bool(d.get('report'))}
print(json.dumps(out,ensure_ascii=False))
PY
