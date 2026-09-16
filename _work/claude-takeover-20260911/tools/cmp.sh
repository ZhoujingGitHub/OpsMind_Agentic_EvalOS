set -eu
# 并排对比多个 Trial 的 task_success 断言证据与硬门。
# 参数化于 2026-09-16：原先钉死 09-11 那两个 trial ID。
: "${PAIRS:?用法: PAIRS='标签:trial_id 标签:trial_id ...'，例如 PAIRS='AH-chain3:trial_abc LG-chain4:trial_def'}"
python3 - "$PAIRS" <<'PY'
import json,sys,urllib.error,urllib.request
PAIRS=[p.split(':',1) for p in sys.argv[1].split()]
assert all(len(p)==2 and p[1] for p in PAIRS), '每项都要写成 标签:trial_id'
def get(p):
 r=urllib.request.Request('http://127.0.0.1:3000'+p,headers={'content-type':'application/json'})
 try:
  with urllib.request.urlopen(r,timeout=90) as x:return json.load(x)
 except urllib.error.HTTPError as e: return {'__http':e.code}
for tag,tid in PAIRS:
    t=get('/api/workbench/trials/'+tid)
    g=(t.get('graders') or [{}])[0].get('result') or {}
    print('='*70); print(tag,tid,' grader=',g.get('grader_version'),' total=',g.get('total'))
    a=(g.get('assertions') or {})
    print('--- task_success 断言证据 ---')
    print(json.dumps(a.get('task_success'),ensure_ascii=False,indent=1))
    print('--- 硬门 ---')
    print(json.dumps(g.get('hard_gates'),ensure_ascii=False))
PY
