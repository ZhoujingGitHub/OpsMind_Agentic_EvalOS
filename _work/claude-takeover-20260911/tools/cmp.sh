set -eu
python3 <<'PY'
import json,urllib.request,urllib.error
def get(p):
 r=urllib.request.Request('http://127.0.0.1:3000'+p,headers={'content-type':'application/json'})
 try:
  with urllib.request.urlopen(r,timeout=90) as x:return json.load(x)
 except urllib.error.HTTPError as e: return {'__http':e.code}
for tag,tid in (('AH-chain3','trial_d0cd88d0a0aa0700452e'),('LG-chain4','trial_b5c10dfd80c54d2e8dea')):
    t=get('/api/workbench/trials/'+tid)
    g=(t.get('graders') or [{}])[0].get('result') or {}
    print('='*70); print(tag,' grader=',g.get('grader_version'),' total=',g.get('total'))
    a=(g.get('assertions') or {})
    print('--- task_success 断言证据 ---')
    print(json.dumps(a.get('task_success'),ensure_ascii=False,indent=1))
    print('--- 硬门 ---')
    print(json.dumps(g.get('hard_gates'),ensure_ascii=False))
PY
