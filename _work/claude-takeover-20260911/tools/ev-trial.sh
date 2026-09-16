set -eu
python3 - "$TRIALQ" <<'PY'
import json,sys,urllib.request,urllib.error
def get(p):
 r=urllib.request.Request('http://127.0.0.1:3000'+p,headers={'content-type':'application/json'})
 try:
  with urllib.request.urlopen(r,timeout=90) as x:return json.load(x)
 except urllib.error.HTTPError as e: return {'__http':e.code,'body':e.read()[:300].decode('utf-8','replace')}
req=get('/api/workbench/run-requests/'+sys.argv[1])['request']
items=req.get('items') or []
print(json.dumps({'request_status':req.get('status'),'experiment':req.get('created_experiment_id'),
 'items':[{k:i.get(k) for k in ('id','trial_id','status','case_ref','contestant_ref')} for i in items],
 'decision_report':req.get('decision_report')},ensure_ascii=False)[:900])
for i in items:
    tid=i.get('trial_id')
    if not tid: continue
    t=get('/api/workbench/trials/'+tid)
    tr=t.get('trial') or {}
    print('==== TRIAL',tid)
    print(json.dumps({k:tr.get(k) for k in ('id','status','score','verdict','qualification','attempt','started_at','completed_at','usage','error')},ensure_ascii=False)[:1200])
    g=t.get('graders') or []
    print('-- graders:',len(g))
    for gr in g[:3]:
        print('  ',json.dumps({k:gr.get(k) for k in ('grader_ref','version','score','max_score','passed','qualification_passed')},ensure_ascii=False)[:400])
        asrt=gr.get('assertions') or gr.get('results') or []
        hard=[a for a in asrt if a.get('hard_gate') or a.get('required')]
        print('   assertions:',len(asrt),' hard:',len(hard),
              ' hard_passed:',sum(1 for a in hard if a.get('passed')))
        for a in asrt:
            if (a.get('hard_gate') or a.get('required')) and not a.get('passed'):
                print('   FAILED HARD:',json.dumps({k:a.get(k) for k in ('rule_id','id','title','reason_zh','reason','score')},ensure_ascii=False)[:300])
PY
