set -eu
# 只读：量三件事的真实分布，用来判断提案里三处改动各会影响几例
#   A 档位分布（门判过之后的生效档位）
#   B 自称 confirmed 且自己填了 missing_evidence 的有几例 —— 第四根杆会影响的就是这些
#   C 血缘独立性余量：每个领先假设实际拿到几个独立血缘（=2 就是刚好卡线）
python3 - <<'PY'
import collections,json,pathlib,urllib.request
cfg=dict(l.split('=',1) for l in pathlib.Path('/etc/opsmind-candidate-relay/agent-harness-v2.env').read_text().splitlines() if '=' in l and not l.startswith('#'))
t=pathlib.Path(cfg['EVALOS_RELAY_TOKEN_DIR'],'candidate_submitter').read_text().strip()
def get(p):
 r=urllib.request.Request(cfg['EVALOS_RELAY_PRODUCT_ORIGIN']+p,headers={'Authorization':'Bearer '+t,'x-tenant-id':'tenant-ctyun-ops-demo'})
 with urllib.request.urlopen(r,timeout=90) as x:return json.load(x)
listing=get('/v2/investigations')
rows=listing if isinstance(listing,list) else (listing.get('items') or listing.get('investigations') or [])
ids=[str(r.get('investigation_id')) for r in rows if isinstance(r,dict) and r.get('investigation_id')]
tier=collections.Counter(); hit=[]; spans=collections.Counter(); recs=collections.Counter()
for i in ids:
 try: d=get('/v2/investigations/'+i)
 except Exception: continue
 rep=d.get('report') or {}; g=rep.get('evidence_gate') or {}
 cs=str(rep.get('conclusion_status')); tier[cs]+=1
 me=[x for x in (rep.get('missing_evidence') or []) if str(x).strip()]
 for r in (rep.get('recommendations') or []):
  if isinstance(r,dict): recs[str(r.get('kind'))]+=1
 for c in (g.get('hypothesis_checks') or []):
  if isinstance(c,dict): spans[c.get('independent_lineage_count')]+=1
 if cs=='confirmed' and me:
  hit.append((i,len(me),[str(x)[:90] for x in me[:2]]))
print('A 生效档位分布 :',dict(tier))
print('C 领先假设拿到的独立血缘数分布 :',dict(spans),' （门要求 >=2）')
print('  建议 kind 分布 :',dict(recs))
print()
print('B 自称 confirmed 且自己列了缺口的例数 :',len(hit),'/',len(ids))
print('  —— 第四根杆（确认 vs 概然）会把这些降为 probable')
for i,n,sample in hit:
 print('  INV',i,' 缺口条数',n)
 for s in sample: print('      -',s)
if not hit: print('  （没有这种样本：要么缺口都填空，要么都不自称 confirmed）')
PY
