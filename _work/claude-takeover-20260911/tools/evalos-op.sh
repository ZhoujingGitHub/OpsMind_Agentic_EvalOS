set -eu
python3 - "$OP" "$REF" "$ARG1" "$ARG2" <<'PY'
import datetime,json,pathlib,re,sys,urllib.error,urllib.request
OP,REF,ARG1,ARG2=sys.argv[1:5]
assert OP in {'preflight','submit','status','progress','details'}
assert REF in {'agent-harness-v2','langgraph-v1'}
IDEM={'agent-harness-v2':'ah-claude-takeover-20260911-evalos-01','langgraph-v1':'lg-claude-takeover-20260911-evalos-01'}[REF]
base={'mode':'QUICK_VALIDATION','request_kind':'NEW_EVALUATION','evaluation_purpose':'SINGLE_SYSTEM_REGRESSION',
 'source_experiment_id':'exp_3d36f6e4067a5ac8c227','case_refs':['M3-OBS-001@3.2.0'],'contestant_refs':[REF],
 'environment_seeds':[2026081601],'repetitions':1,'requested_concurrency':1,
 'requested_by':'product-manager-authorized-takeover-four-chain-acceptance-20260911',
 'reason':'接管方按产品经理授权执行四条链路真实验收：同一冻结 Case M3-OBS-001@3.2.0 与种子 2026081601，单槽位独占串行，核对独立审批、执行、独立业务验证与归档。不作为正式排名，不改评分权重与历史账本。',
 'idempotency_key':IDEM}
rel=json.loads(pathlib.Path('/opt/opsmind-evalos/current/evalos/RELEASE.json').read_text())
assert rel['source_revision']=='41d99bc40421e4ec4552a002b640487c342eafac', rel['source_revision']
def call(path,payload=None,headers=None,timeout=120):
 data=None if payload is None else json.dumps(payload,ensure_ascii=False,separators=(',',':')).encode()
 h={'content-type':'application/json',**(headers or {})}
 req=urllib.request.Request('http://127.0.0.1:3000'+path,data=data,headers=h,method='GET' if payload is None else 'POST')
 try:
  with urllib.request.urlopen(req,timeout=timeout) as r:return json.load(r)
 except urllib.error.HTTPError as e:
  p=json.loads(e.read()); pre=p.get('preflight',{})
  raise RuntimeError('EvalOS HTTP %d: %s'%(e.code,json.dumps({'error':p.get('error'),'blockers':pre.get('blockers'),
   'readiness':pre.get('readiness'),'candidates':[{k:c.get(k) for k in ['ref','ready','health','twin','credentials','presence','limitations']} for c in pre.get('candidate_checks',[])]},ensure_ascii=False))) from None
def ident(v):
 assert re.fullmatch(r'[A-Za-z0-9_-]+',v); return v
if OP=='preflight': out={'preflight':call('/api/workbench/run-requests/preflight',base)['preflight']}
elif OP=='submit':
 v=call('/api/workbench/run-requests',base,{'idempotency-key':IDEM},180); r=v['request']
 out={'created':v['created'],'request':{k:r.get(k) for k in ['id','mode','status','source_experiment_id','created_experiment_id','selection','error','created_at','started_at']}}
elif OP=='status':
 r=call('/api/workbench/run-requests/'+ident(ARG1))['request']
 out={'request':{k:r.get(k) for k in ['id','status','created_experiment_id','selection','error','created_at','started_at','completed_at','progress','decision_report','items']}}
elif OP=='progress':
 d=call('/api/workbench/trials/'+ident(ARG1))
 out={'trial':{k:d['trial'].get(k) for k in ['id','status','attempt','error','started_at','completed_at','usage','score','verdict']},
      'live_progress':d.get('live_progress'),'evidence':{k:v for k,v in (d.get('evidence') or {}).items() if k!='artifacts'}}
elif OP=='details':
 t=call('/api/workbench/trials/'+ident(ARG1))
 out={'trial':t['trial'],'graders':t.get('graders'),'judges':t.get('judges'),'case':t.get('case'),
      'evidence':{k:v for k,v in (t.get('evidence') or {}).items() if k!='artifacts'},
      'attempts':t.get('attempts'),'cleanup_reconciliations':t.get('cleanup_reconciliations')}
print(json.dumps({'op':OP,'ref':REF,'evalos':{k:rel[k] for k in ['release_id','source_revision','content_digest']},
 'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'result':out},ensure_ascii=False,default=str))
PY
