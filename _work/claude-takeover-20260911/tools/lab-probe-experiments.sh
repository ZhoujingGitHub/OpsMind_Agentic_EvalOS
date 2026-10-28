# 校准实验（一次性、只在 AH 拓扑上做）：故障参数改成什么，业务探针才看得见。
# 远端 POSIX sh，root。每个实验：prepare → 可选的额外命令 → 连测 3 次业务探针并记耗时 → reset。
set -u
C=/usr/local/sbin/opsmind-harness-labctl
measure() {  # $1 trial id
  for n in 1 2 3; do
    "$C" business-verify "$1" | python3 -c 'import json,sys
d=json.load(sys.stdin)["business_verification"]; c=d["checks"]
def ms(x): return x.get("elapsed_ms") or x.get("duration_ms")
print("   passed=%s dns=%s(%sms) http=%s(%sms)" % (d["passed"], c["dns"].get("resolved"), ms(c["dns"]), c["http"].get("healthy"), ms(c["http"])))'
  done
}
exp() {  # $1 label  $2 scenario  $3 extra shell command (may be empty)
  t="ah-calib-exp-$(date -u +%H%M%S)"
  echo "== $1"
  "$C" manage-prepare "$t" "$2" 7 agent_harness_direct >/dev/null || { echo "   prepare failed"; return; }
  [ -n "$3" ] && sh -c "$3"
  sleep 3
  measure "$t"
  "$C" manage-reset "$t" | python3 -c 'import json,sys;print("   reset clean=%s" % json.load(sys.stdin).get("clean"))'
}
exp "healthy baseline" healthy-baseline ""
exp "user-plane-latency (netem 250ms±20ms on ogstun)" user-plane-latency ""
exp "rate-limit as shipped (tbf 16kbit burst 1600)" transport-rate-limit ""
exp "rate-limit tbf 2kbit burst 400 latency 50ms" transport-rate-limit "tc -n opsmind-ah-b qdisc change dev ah-b-c root tbf rate 2kbit burst 400 latency 50ms"
exp "rate-limit tbf 1kbit burst 200 latency 50ms" transport-rate-limit "tc -n opsmind-ah-b qdisc change dev ah-b-c root tbf rate 1kbit burst 200 latency 50ms"
exp "nrf down + UE re-registration" nrf-process-down "systemctl restart ueransim-ue; sleep 8"
