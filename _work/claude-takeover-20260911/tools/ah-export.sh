set -eu
python3 - <<'PY'
import json,pathlib,urllib.request,hashlib,base64
cfg=dict(l.split('=',1) for l in pathlib.Path('/etc/opsmind-candidate-relay/agent-harness-v2.env').read_text().splitlines() if '=' in l and not l.startswith('#'))
t=pathlib.Path(cfg['EVALOS_RELAY_TOKEN_DIR'],'candidate_submitter').read_text().strip()
def get(p):
 r=urllib.request.Request(cfg['EVALOS_RELAY_PRODUCT_ORIGIN']+p,headers={'Authorization':'Bearer '+t,'x-tenant-id':'tenant-ctyun-ops-demo'})
 with urllib.request.urlopen(r,timeout=90) as x:return json.load(x)
d=get('/v2/investigations/inv-608b343f5330')
raw=json.dumps(d,ensure_ascii=False,sort_keys=True).encode()
print(json.dumps({'bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest(),
 'investigation_id':'inv-608b343f5330','n_events':len(d.get('events') or []),
 'n_evidence':len(d.get('evidence') or [])},ensure_ascii=False))
print('BUNDLE_B64_START')
print(base64.b64encode(__import__('gzip').compress(raw)).decode())
print('BUNDLE_B64_END')
PY
