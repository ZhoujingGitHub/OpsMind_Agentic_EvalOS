set -eu
# 诊断 AH 调查为什么停在这里：stop_reason / error_message / status_semantics / 证据闸。
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
for k in ('status','conclusion_status','stop_reason','error_message','status_semantics','started_at','completed_at'):
    print(k,'=',json.dumps(d.get(k),ensure_ascii=False)[:900])
rep=d.get('report') or {}
print('report.conclusion_status=',json.dumps(rep.get('conclusion_status'),ensure_ascii=False)[:300])
print('report.stop_reason=',json.dumps(rep.get('stop_reason'),ensure_ascii=False)[:400])
print('report.evidence_gate=',json.dumps(rep.get('evidence_gate'),ensure_ascii=False)[:700])
print('report.summary=',json.dumps(rep.get('summary'),ensure_ascii=False)[:900])
print('report.missing_evidence=',json.dumps(rep.get('missing_evidence'),ensure_ascii=False)[:500])
print('n_hypotheses=',len(rep.get('hypotheses') or []),' n_evidence=',len(d.get('evidence') or []),' n_events=',len(d.get('events') or []))
PY
