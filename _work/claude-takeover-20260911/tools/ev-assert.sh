set -eu
python3 - "$TID" <<'PY'
import json,sys,urllib.request,urllib.error
TID=sys.argv[1]
def get(p):
 r=urllib.request.Request('http://127.0.0.1:3000'+p,headers={'content-type':'application/json'})
 try:
  with urllib.request.urlopen(r,timeout=90) as x:return json.load(x)
 except urllib.error.HTTPError as e: return {'__http':e.code}
t=get('/api/workbench/trials/'+TID)
g=(t.get('graders') or [{}])[0].get('result') or {}
print('== total',g.get('total'),'passed',g.get('passed'),'qual',g.get('qualification_passed'))
a=g.get('assertions') or {}
for k,v in a.items():
    print('--',k,'value=',round(v.get('value',0),4) if isinstance(v.get('value'),(int,float)) else v.get('value'),
          'passed=',v.get('passed'),'applicable=',v.get('applicable'))
    ev=v.get('evidence') or {}
    print('     evidence:',json.dumps(ev,ensure_ascii=False)[:700])
print()
print('== hard gates / qualification ==')
for k in ('qualification','hard_gates','gates','qualification_checks'):
    if k in g: print(k,'=',json.dumps(g[k],ensure_ascii=False)[:2000])
ev=t.get('evidence') or {}
print()
print('== evidence keys:',list(ev.keys()))
for k,v in ev.items():
    s=json.dumps(v,ensure_ascii=False)
    if 'reception_errors' in s or 'recovery_verified' in s:
        print('--',k,':',s[:1500])
PY
