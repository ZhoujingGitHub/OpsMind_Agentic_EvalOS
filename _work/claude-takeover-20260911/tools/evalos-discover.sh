# EvalOS 只读发现：考场自己从两个考生的公开接口确定性算出 5 个指纹，并与冻结清单比漂移。
# 远端 POSIX sh。用法：./run-on.sh evalos evalos-discover.sh
# 不建 Trial、不碰实验室、不写库（接口自报 production_writes=false）。
set -eu
TOKEN=$(sed -n 's/^EVALOS_API_TOKEN=//p' /etc/opsmind-evalos/evalos.env | tr -d '"')
[ -n "$TOKEN" ] || { echo "读不到 EVALOS_API_TOKEN"; exit 2; }
curl -sf -H "authorization: Bearer $TOKEN" \
  "http://127.0.0.1:8787/api/candidate-adapters/discover?contract_version=5.0" > /tmp/evalos-discover.json
python3 - <<'PY'
import json
d = json.load(open("/tmp/evalos-discover.json"))
items = d.get("items") or d.get("candidates") or d
for item in (items if isinstance(items, list) else [items]):
    ref = item.get("candidate_ref") or item.get("ref")
    disc = item.get("discovery") or item
    print("==", ref, "writes=", disc.get("production_writes_available"), "drift=", json.dumps(item.get("drift"), ensure_ascii=False)[:600])
    for k in ("source_revision", "artifact_digest", "runtime_digest", "runtime_manifest_digest", "capability_contract_digest"):
        print("  ", k, disc.get(k))
    runtime = disc.get("candidate_runtime") or {}
    print("   models", json.dumps(runtime.get("models"), ensure_ascii=False))
print("keys:", list(d.keys()) if isinstance(d, dict) else type(d))
PY
