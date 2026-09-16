set -eu
python3 - <<'PY'
import json,pathlib,urllib.request
cfg=dict(l.split('=',1) for l in pathlib.Path('/etc/opsmind-candidate-relay/agent-harness-v2.env').read_text().splitlines() if '=' in l and not l.startswith('#'))
t=pathlib.Path(cfg['EVALOS_RELAY_TOKEN_DIR'],'candidate_submitter').read_text().strip()
def get(p):
 r=urllib.request.Request(cfg['EVALOS_RELAY_PRODUCT_ORIGIN']+p,headers={'Authorization':'Bearer '+t,'x-tenant-id':'tenant-ctyun-ops-demo'})
 with urllib.request.urlopen(r,timeout=60) as x:return json.load(x)
d=get('/v2/investigations/inv-608b343f5330')
for k in ('status','conclusion_status','stop_reason','error_message','status_semantics','started_at','completed_at'):
    print(k,'=',json.dumps(d.get(k),ensure_ascii=False)[:900])
rep=d['report']
print('report.conclusion_status=',json.dumps(rep.get('conclusion_status'),ensure_ascii=False)[:300])
print('report.stop_reason=',json.dumps(rep.get('stop_reason'),ensure_ascii=False)[:400])
print('report.evidence_gate=',json.dumps(rep.get('evidence_gate'),ensure_ascii=False)[:700])
print('report.summary=',json.dumps(rep.get('summary'),ensure_ascii=False)[:900])
print('report.missing_evidence=',json.dumps(rep.get('missing_evidence'),ensure_ascii=False)[:500])
print('n_hypotheses=',len(rep.get('hypotheses') or []),' n_evidence=',len(d.get('evidence') or []),' n_events=',len(d.get('events') or []))
PY
