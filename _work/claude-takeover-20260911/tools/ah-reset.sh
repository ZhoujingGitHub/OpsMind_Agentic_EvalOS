set -eu
python3 - <<'PY'
import json,pathlib,urllib.request,datetime
cfg=dict(l.split('=',1) for l in pathlib.Path('/etc/opsmind-candidate-relay/agent-harness-v2.env').read_text().splitlines() if '=' in l and not l.startswith('#'))
t=pathlib.Path(cfg['EVALOS_RELAY_TOKEN_DIR'],'candidate_submitter').read_text().strip()
def req(p,m='GET',body=None):
 r=urllib.request.Request(cfg['EVALOS_RELAY_PRODUCT_ORIGIN']+p,data=body,
  headers={'Authorization':'Bearer '+t,'x-tenant-id':'tenant-ctyun-ops-demo','content-type':'application/json'},method=m)
 with urllib.request.urlopen(r,timeout=220) as x:return json.load(x)
inv='inv-608b343f5330'
lab=req('/v2/protocol-lab')
if lab.get('active_trial') is None and lab['physical_lease']['status']=='idle':
 reset={'already_idle':True}
else:
 assert lab['active_trial']=='ah-claude-takeover-20260911-01', lab
 assert lab['physical_lease']['owner_mode']=='agent_harness_direct'
 reset=req('/v2/investigations/'+inv+'/protocol-lab/reset','POST',b'{}')
lab=req('/v2/protocol-lab')
print(json.dumps({'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'reset':reset,
 'active_trial':lab.get('active_trial'),'lease_status':lab['physical_lease']['status'],
 'idle':lab.get('active_trial') is None and lab['physical_lease']['status']=='idle'},ensure_ascii=False))
PY
