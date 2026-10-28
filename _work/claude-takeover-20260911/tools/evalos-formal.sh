# EvalOS 正式考试：先预检，ready 才提交。远端 POSIX sh，考场机。
#   ./run-on.sh evalos evalos-formal.sh SRC_EXP=<冻结源> IDEM=<本轮唯一幂等键> [OP=preflight|submit]
# 正式考试必须是完整冻结题库 × 两名考生（API 会拒绝子集）；并发固定 1——实验室只有一个物理租约。
# 主机上 EVALOS_M3_FORMAL_RUN_ENABLED=1 才能放行（10-29 已开）。
set -eu
: "${SRC_EXP:?SRC_EXP=<当次冻结源实验，例如 exp_5bd93c799006a62d3099>}"
: "${IDEM:?IDEM=<本轮唯一幂等键；复用旧键会拿回上次那个请求>}"
OP="${OP:-preflight}"
python3 - "$SRC_EXP" "$IDEM" "$OP" <<'PY'
import json, sys, urllib.error, urllib.request
src, idem, op = sys.argv[1:4]
def call(path, body=None):
    data = None if body is None else json.dumps(body, ensure_ascii=False).encode()
    req = urllib.request.Request("http://127.0.0.1:3000" + path, data=data, method="GET" if body is None else "POST",
                                 headers={"content-type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=180) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        raise SystemExit("HTTP %d %s" % (error.code, error.read()[:1500].decode("utf-8", "replace")))
templates = call("/api/workbench/run-templates")["items"]
frozen = next((item for item in templates if item["id"] == src), None)
assert frozen, "冻结源不在可用模板里：%s（模板：%s）" % (src, [t["id"] for t in templates])
body = {"request_kind": "NEW_EVALUATION", "evaluation_purpose": "PAIRED_COMPARISON", "mode": "FORMAL",
        "source_experiment_id": src, "case_refs": frozen["case_refs"],
        "contestant_refs": sorted(item["ref"] for item in frozen["contestants"]),
        "environment_seeds": frozen.get("environment_seeds") or None, "repetitions": 1, "requested_concurrency": 1,
        "requested_by": "product-manager-authorized-m33-formal-20261029",
        "reason": "M3.3 正式考试：22 道运维大类真注入 × 6 种考法，每考生 40 场，两考生共 80 场；按产品经理 10-29 授权执行。",
        "idempotency_key": idem}
body = {key: value for key, value in body.items() if value is not None}
pre = call("/api/workbench/run-requests/preflight", body)["preflight"]
print(json.dumps({"ready": pre["ready"], "blockers": pre["blockers"], "total_trials": pre["total_trials"],
                  "affects_official_score": pre.get("affects_official_score"),
                  "contestants": [{k: c.get(k) for k in ("ref", "source_revision")} for c in pre.get("contestants", [])]},
                 ensure_ascii=False))
if op == "submit":
    assert pre["ready"], "预检未通过，不提交"
    result = call("/api/workbench/run-requests", body)
    request = result.get("request") or result
    print(json.dumps({"request_id": request.get("id"), "status": request.get("status"), "mode": request.get("mode")},
                     ensure_ascii=False))
PY
