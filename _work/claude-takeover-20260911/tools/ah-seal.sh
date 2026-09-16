set -eu
mkdir -p /srv/opsmind-evidence/claude-takeover-20260911
python3 - <<'PY'
import json,pathlib,urllib.request,hashlib
cfg=dict(l.split('=',1) for l in pathlib.Path('/etc/opsmind-candidate-relay/agent-harness-v2.env').read_text().splitlines() if '=' in l and not l.startswith('#'))
t=pathlib.Path(cfg['EVALOS_RELAY_TOKEN_DIR'],'candidate_submitter').read_text().strip()
def get(p):
 r=urllib.request.Request(cfg['EVALOS_RELAY_PRODUCT_ORIGIN']+p,headers={'Authorization':'Bearer '+t,'x-tenant-id':'tenant-ctyun-ops-demo'})
 with urllib.request.urlopen(r,timeout=90) as x:return json.load(x)
d=get('/v2/investigations/inv-608b343f5330')
raw=json.dumps(d,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode()
out=pathlib.Path('/srv/opsmind-evidence/claude-takeover-20260911/ah-chain1-inv-608b343f5330.json')
out.write_bytes(raw)
import gzip
gz=out.with_suffix('.json.gz'); gz.write_bytes(gzip.compress(raw))
a=(d.get('repair_delivery') or {}).get('actions',[{}])[0]
bv=a.get('business_verification') or {}
summary={'sealed_path':str(out),'bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest(),
 'gz_bytes':gz.stat().st_size,'gz_sha256':hashlib.sha256(gz.read_bytes()).hexdigest(),
 'investigation_id':d['investigation_id'],'status':d['status'],'status_semantics':d.get('status_semantics'),
 'conclusion_status':d.get('conclusion_status'),'stop_reason':d.get('stop_reason'),
 'error_message':d.get('error_message'),'started_at':d.get('started_at'),'completed_at':d.get('completed_at'),
 'n_events':len(d.get('events') or []),'n_evidence':len(d.get('evidence') or []),
 'usage':{k:(d.get('usage') or {}).get(k) for k in ('tool_calls','model_calls','result_bytes')},
 'action':{k:a.get(k) for k in ('action_id','action_type','approval_status','execution_status','business_status','verified_at')},
 'business_checks':{k:{kk:v.get(kk) for kk in ('status','resolved','rcode','answers','http_status','source','target')} for k,v in (bv.get('checks') or {}).items()},
 'business_passed':bv.get('passed'),
 'report':{'root_cause':(d.get('report') or {}).get('root_cause'),'conclusion_status':(d.get('report') or {}).get('conclusion_status'),
   'delivery_status':((d.get('report') or {}).get('delivery_receipt') or {}).get('status'),
   'report_digest':((d.get('report') or {}).get('delivery_receipt') or {}).get('report_digest')}}
print(json.dumps(summary,ensure_ascii=False,indent=1))
PY
