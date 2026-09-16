set -eu
# 把 AH 调查全量导出为 gzip+base64（云助手输出有长度上限，大包请改用 ah-seal.sh 落盘）。
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
raw=json.dumps(d,ensure_ascii=False,sort_keys=True).encode()
print(json.dumps({'bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest(),
 'investigation_id':INV,'n_events':len(d.get('events') or []),
 'n_evidence':len(d.get('evidence') or [])},ensure_ascii=False))
print('BUNDLE_B64_START')
print(base64.b64encode(gzip.compress(raw)).decode())
print('BUNDLE_B64_END')
PY
