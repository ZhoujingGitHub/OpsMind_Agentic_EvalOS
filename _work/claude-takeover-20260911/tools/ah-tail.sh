set -eu
# 看 AH 调查的事件尾部与在途工具调用。
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
ev=d.get('events') or []
print('INVESTIGATION:',INV,' total events',len(ev))
print('--- 事件类型分布 ---')
for k,v in collections.Counter(e.get('event_type') or e.get('type') for e in ev).most_common(20): print(' ',k,v)
print('--- 最后 12 条 ---')
for e in ev[-12:]:
    print(' ',e.get('created_at') or e.get('at'), '|', e.get('event_type') or e.get('type'), '|', json.dumps(e.get('public_payload_json') or e.get('payload') or {},ensure_ascii=False)[:220])
tc=d.get('tool_calls') or []
print('--- tool_calls 尾部 6 条 ---')
for c in tc[-6:]:
    print(' ',json.dumps({k:c.get(k) for k in ('name','tool_name','status','started_at','completed_at','error_type','duration_ms')},ensure_ascii=False)[:300])
PY
