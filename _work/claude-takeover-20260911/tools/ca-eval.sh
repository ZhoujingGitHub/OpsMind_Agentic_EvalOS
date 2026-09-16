#!/bin/bash
# Cloud Assistant runner. $1=instance-id $2=timeout-sec ; stdin=script
AL="D:/AIPM/黄钊+张和AIPM训练营/5期/从0到1打造一个Agent落地产品/OpsMind/.tools/aliyuncli/aliyun.exe"
PY="D:/install/anaconda3/python.exe"
INST="$1"; TMO="${2:-120}"
B64=$(cat | base64 -w0)
# RunCommand retry. A lost response does not prove the command never ran, so every
# attempt reuses one ClientToken: Cloud Assistant then returns the original invocation
# instead of starting a second copy of the script on the host.
CT=$("$PY" -c "import uuid;print(uuid.uuid4())")
IID=""
for attempt in 1 2 3 4 5 6; do
  raw=$("$AL" --profile opsmind-evallab ecs RunCommand --RegionId cn-hangzhou --ClientToken "$CT" --InstanceId.1 "$INST" --Type RunShellScript --Timeout "$TMO" --CommandContent "$B64" --ContentEncoding Base64 2>/dev/null)
  IID=$(printf %s "$raw" | "$PY" -c "import sys,json;print(json.load(sys.stdin)['InvokeId'])" 2>/dev/null)
  [ -n "$IID" ] && break
  echo "RunCommand attempt $attempt failed, retrying" >&2
  "$PY" -c "import time;time.sleep(5)"
done
[ -z "$IID" ] && { echo "RunCommand failed"; exit 1; }
echo "InvokeId=$IID" >&2
for i in $(seq 1 120); do
  raw=$("$AL" --profile opsmind-evallab ecs DescribeInvocationResults --RegionId cn-hangzhou --InvokeId "$IID" 2>/dev/null)
  out=$(printf '%s' "$raw" | "$PY" -X utf8 -c "
import sys,json,base64
try: d=json.loads(sys.stdin.read())
except Exception: print('__WAIT__'); raise SystemExit
try: r=d['Invocation']['InvocationResults']['InvocationResult'][0]
except Exception: print('__WAIT__'); raise SystemExit
st=r.get('InvocationStatus')
if st in ('Running','Pending','Invoking',None): print('__WAIT__')
else:
    print('### exit='+str(r.get('ExitCode'))+' status='+str(st))
    print(base64.b64decode(r.get('Output','') or '').decode('utf-8','replace'))
    if r.get('ErrorInfo'): print('### ErrorInfo: '+str(r.get('ErrorInfo')))
" 2>/dev/null)
  if [ -n "$out" ] && [ "$out" != "__WAIT__" ]; then echo "$out"; exit 0; fi
  "$PY" -c "import time;time.sleep(5)"
done
echo "### timeout waiting for $IID"
