set -eu
# 走产品 API 复位 AH 占用的实验室租约。复位后必须确认 lease.status==idle。
# 参数化于 2026-09-16：原先调查编号与 trial 命名空间写死在断言里。
: "${INV:?用法: INV=<inv-id> NS=<本轮 trial 命名空间> [OWNER=agent_harness_direct]}"
: "${NS:?必须指明本轮 trial 命名空间（断言会核对复位的是你这一轮，不是别人的）}"
OWNER="${OWNER:-agent_harness_direct}"
python3 - "$INV" "$NS" "$OWNER" <<'PY'
import datetime,json,pathlib,sys,urllib.request
INV,NS,OWNER=sys.argv[1:4]
cfg=dict(l.split('=',1) for l in pathlib.Path('/etc/opsmind-candidate-relay/agent-harness-v2.env').read_text().splitlines() if '=' in l and not l.startswith('#'))
t=pathlib.Path(cfg['EVALOS_RELAY_TOKEN_DIR'],'candidate_submitter').read_text().strip()
def req(p,m='GET',body=None):
 r=urllib.request.Request(cfg['EVALOS_RELAY_PRODUCT_ORIGIN']+p,data=body,
  headers={'Authorization':'Bearer '+t,'x-tenant-id':'tenant-ctyun-ops-demo','content-type':'application/json'},method=m)
 with urllib.request.urlopen(r,timeout=220) as x:return json.load(x)
lab=req('/v2/protocol-lab')
if lab.get('active_trial') is None and lab['physical_lease']['status']=='idle':
 reset={'already_idle':True}
else:
 assert lab['active_trial']==NS, (lab.get('active_trial'),NS)
 assert lab['physical_lease']['owner_mode']==OWNER, lab['physical_lease']
 reset=req('/v2/investigations/'+INV+'/protocol-lab/reset','POST',b'{}')
lab=req('/v2/protocol-lab')
print(json.dumps({'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'investigation_id':INV,'reset':reset,
 'active_trial':lab.get('active_trial'),'lease_status':lab['physical_lease']['status'],
 'idle':lab.get('active_trial') is None and lab['physical_lease']['status']=='idle'},ensure_ascii=False))
PY
