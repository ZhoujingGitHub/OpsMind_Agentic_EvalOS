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
print('trial keys:',sorted(t.keys()))
for key in ('graders','grader_runs','scores','grading'):
    if key in t:
        print('==',key,'==')
        print(json.dumps(t[key],ensure_ascii=False)[:3000])
PY
