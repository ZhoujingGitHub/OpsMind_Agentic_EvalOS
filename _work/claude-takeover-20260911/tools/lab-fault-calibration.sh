# 实验室故障空跑校准：不调任何模型、不建 EvalOS Trial，只验证「题目本身成立」。
# 远端 POSIX sh，在实验室以 root 运行（run-on.sh lab 自带 sudo -n）。
#
#   ./run-on.sh lab lab-fault-calibration.sh [SCENARIOS="a b c"] [CANDIDATES="ah lg"]
#
# 每个（考生拓扑 × 场景）走一遍：
#   ① manage-prepare（直连模式，注入故障）
#   ② business-verify：实验室独立复测业务——有故障的题不许是「通」（「不通」或「测不了」都算
#      故障成立：AMF 停了连会话都建不起来，探针无从测起），无故障对照题必须「通」
#   ③ manage-reset：复位后基线必须 clean，物理租约必须回到 idle
# 任何一步不符就记 FAIL；注入失败先 recover（先证明基线干净才放租约），
# 复位或 recover 不 clean 立即停（实验室不能带病进下一题）。
# 输出一行一题，最后一行是汇总；全文另存 /var/tmp/lab-fault-calibration-<时间>.jsonl。
set -u
ALL="amf-process-down smf-process-down upf-process-down nrf-process-down mongodb-process-down gnb-process-crash
transport-link-down transport-packet-loss transport-rate-limit transport-route-loop n6-route-missing
radio-link-degraded radio-link-down sctp-blocked pfcp-blocked gtpu-blocked dns-blocked
subscriber-missing subscriber-key-mismatch user-plane-latency healthy-baseline harmless-rule"
SCENARIOS="${SCENARIOS:-$ALL}"
CANDIDATES="${CANDIDATES:-ah lg}"
OUT=/var/tmp/lab-fault-calibration-$(date -u +%Y%m%dT%H%M%SZ).jsonl
pass=0; fail=0
recover() {
  r=$(/usr/local/sbin/opsmind-twinctl request "$(python3 -c 'import base64,json;print(base64.urlsafe_b64encode(json.dumps({"operation":"recover"}).encode()).decode().rstrip("="))')")
  printf '%s' "$r" | python3 -c 'import json,sys
try: print(str(json.loads(sys.stdin.read()).get("clean")).lower())
except Exception: print("unreadable")'
}
for cand in $CANDIDATES; do
  case "$cand" in
    ah) CTL=/usr/local/sbin/opsmind-harness-labctl; MODE=agent_harness_direct ;;
    lg) CTL=/usr/local/sbin/opsmind-langgraph-labctl; MODE=langgraph_direct ;;
    *) echo "unknown candidate $cand"; exit 2 ;;
  esac
  for scn in $SCENARIOS; do
    tid="$cand-calib-$(date -u +%m%d%H%M%S)-$(printf '%s' "$scn" | cut -c1-12)"
    case "$scn" in healthy-baseline|harmless-rule) want=true ;; *) want=not-true ;; esac
    p=$("$CTL" manage-prepare "$tid" "$scn" 7 "$MODE" 2>&1); prc=$?
    if [ "$prc" != 0 ]; then
      echo "FAIL $cand $scn prepare rc=$prc $(printf '%s' "$p" | tr -d '\n' | cut -c1-200)"
      printf '{"candidate":"%s","scenario":"%s","stage":"prepare","rc":%s}\n' "$cand" "$scn" "$prc" >> "$OUT"
      fail=$((fail+1)); "$CTL" manage-reset "$tid" >/dev/null 2>&1
      if [ "$(recover)" != true ]; then echo "注入失败后 recover 不 clean，停"; break 2; fi
      continue
    fi
    sleep 3
    b=$("$CTL" business-verify "$tid" 2>&1)
    got=$(printf '%s' "$b" | python3 -c 'import json,sys
try: d=json.loads(sys.stdin.read()); v=(d.get("business_verification") or {}).get("passed"); print("null" if v is None else str(v).lower())
except Exception: print("unreadable")')
    r=$("$CTL" manage-reset "$tid" 2>&1)
    clean=$(printf '%s' "$r" | python3 -c 'import json,sys
try: print(str(json.loads(sys.stdin.read()).get("clean")).lower())
except Exception: print("unreadable")')
    verdict=PASS
    if [ "$want" = true ]; then [ "$got" = true ] || verdict=FAIL; else [ "$got" != true ] || verdict=FAIL; fi
    [ "$got" = unreadable ] && verdict=FAIL
    [ "$clean" = true ] || verdict=FAIL
    [ "$verdict" = PASS ] && pass=$((pass+1)) || fail=$((fail+1))
    echo "$verdict $cand $scn business=$got(want $want) reset_clean=$clean"
    printf '{"candidate":"%s","scenario":"%s","business_passed":"%s","expected":"%s","reset_clean":"%s","verdict":"%s"}\n' \
      "$cand" "$scn" "$got" "$want" "$clean" "$verdict" >> "$OUT"
    if [ "$clean" != true ]; then
      echo "复位不 clean，停。现场：$(printf '%s' "$r" | tr -d '\n' | cut -c1-300)"; break 2
    fi
  done
done
echo "SUMMARY pass=$pass fail=$fail log=$OUT"
