set -eu
# EvalOS 控制 API 统一入口（在 EvalOS 机上跑）。
# 注：本脚本走 127.0.0.1:3000，那是**控制台**，它把 /api/workbench/* 代理到控制 API。
# 控制 API 本身在 127.0.0.1:8787（systemd 里 PORT=8787）。像
# /api/candidate-adapters/discover、/api/experiments 这类非 workbench 路由
# 控制台不代理，必须直连 8787 并带 EVALOS_API_TOKEN（在 /etc/opsmind-evalos/evalos.env）。
# 2026-09-16 因为原注释写成"控制 API 只监听 3000"，在这里白绕了一圈。
#
# 参数化于 2026-09-16。原先三处写死，每一处都是静默陷阱：
#   1. 版本守卫钉死 EvalOS 提交 41d99bc4（2026-09-10 的发布），线上一升级就 fail-closed，
#      而且是在调用 preflight 之前就退出 —— 09-14/15 那轮因此根本没法用这个脚本。
#   2. source_experiment_id 钉死 exp_3d36f6e4067a5ac8c227（09-11 登记的冻结源），
#      RUNBOOK 自己写着"不要用历史实验 ID"。
#   3. idempotency_key 钉死 —— 用同一个键再提交，EvalOS 会**返回上次那个请求**
#      而不是新建一个。这一条最像"跑通了"，实则什么都没跑。
#
# 版本守卫保留，但期望值必须每次自己给：这样它永远不会悄悄过期。
#   EXPECT_REV 取当前生产标签指向的提交（EvalOS 仓 git rev-list -n1 prod-evalos-...）
: "${OP:?用法: OP=preflight|submit|status|progress|details REF=agent-harness-v2|langgraph-v1 ...}"
: "${REF:?必须指明候选：agent-harness-v2 或 langgraph-v1}"
: "${EXPECT_REV:?必须指明期望的 EvalOS 线上提交（守卫用，防止对着不认识的版本下发操作）}"
SRC_EXP="${SRC_EXP:-}"
IDEM="${IDEM:-}"
ARG1="${ARG1:--}"
ARG2="${ARG2:--}"
python3 - "$OP" "$REF" "$ARG1" "$ARG2" "$EXPECT_REV" "$SRC_EXP" "$IDEM" <<'PY'
import datetime,json,pathlib,re,sys,urllib.error,urllib.request
OP,REF,ARG1,ARG2,EXPECT_REV,SRC_EXP,IDEM=sys.argv[1:8]
assert OP in {'preflight','submit','status','progress','details'}, OP
assert REF in {'agent-harness-v2','langgraph-v1'}, REF
rel=json.loads(pathlib.Path('/opt/opsmind-evalos/current/evalos/RELEASE.json').read_text())
assert rel['source_revision']==EXPECT_REV, {'live':rel['source_revision'],'expected':EXPECT_REV,
  'hint':'线上 EvalOS 与你声明的期望版本不一致。核对生产标签后再决定是继续还是先对齐版本，不要直接放宽这个守卫。'}
if OP in {'preflight','submit'}:
    assert SRC_EXP, 'preflight/submit 必须给 SRC_EXP=<当次登记生成的最新冻结源实验 ID>，不要用历史值'
    assert re.fullmatch(r'exp_[0-9a-f]{20}', SRC_EXP), SRC_EXP
if OP=='submit':
    assert IDEM, 'submit 必须给 IDEM=<本轮唯一的幂等键>；复用旧键会拿回上次那个请求'
base={'mode':'QUICK_VALIDATION','request_kind':'NEW_EVALUATION','evaluation_purpose':'SINGLE_SYSTEM_REGRESSION',
 'source_experiment_id':SRC_EXP,'case_refs':['M3-OBS-001@3.2.0'],'contestant_refs':[REF],
 'environment_seeds':[2026081601],'repetitions':1,'requested_concurrency':1,
 'requested_by':'product-manager-authorized-four-chain-reacceptance',
 'reason':'按产品经理授权复验四条链路：同一冻结 Case M3-OBS-001@3.2.0 与种子 2026081601，单槽位独占串行，核对独立审批、执行、独立业务验证与归档。不作为正式排名，不改评分权重与历史账本。',
 'idempotency_key':IDEM}
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
 assert re.fullmatch(r'[A-Za-z0-9_-]+',v), v; return v
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
print(json.dumps({'op':OP,'ref':REF,'source_experiment_id':SRC_EXP or None,
 'evalos':{k:rel[k] for k in ['release_id','source_revision','content_digest']},
 'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'result':out},ensure_ascii=False,default=str))
PY
