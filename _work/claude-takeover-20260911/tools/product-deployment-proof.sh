# 产品机只读部署证明：两个考生「线上到底跑的是哪个提交、哪个镜像」，从 docker 读，封存成文件。
# 远端 POSIX sh。用法：./run-on.sh product product-deployment-proof.sh TAG=<证据目录名>
#
# 版本登记（candidate-release-registration.mjs）要一份独立于产品自报的部署证明。
# 这里只做 docker image / container inspect，不改任何东西；输出文件的 sha256 就是
# 登记里 verified_evidence_ref 的一部分。**证明必须落盘**：09-20 那份引用的文件
# 没有留下，事后无从复核——这个脚本就是为了不再那样。
set -eu
: "${TAG:?用法: TAG=<证据目录名，例如 m33-release-20261029>}"
OUT=/srv/opsmind-evidence/$TAG
install -d -m 0755 "$OUT"
F="$OUT/deployment-proof-$(date -u +%Y%m%d).json"
python3 - "$F" <<'PY'
import datetime, json, subprocess, sys
def inspect(*args):
    return subprocess.check_output(["docker", *args], text=True).strip()
candidates = {}
for ref, container, release_dir in (("agent-harness-v2", "opsmind-agent-harness-api", None),
                                    ("langgraph-v1", "opsmind-langgraph-api", "/srv/opsmind-langgraph/current")):
    image = inspect("inspect", "-f", "{{.Config.Image}}", container)
    image_id = inspect("inspect", "-f", "{{.Image}}", container)
    state = inspect("inspect", "-f", "{{.State.Status}}", container)
    revision = inspect("image", "inspect", "-f", '{{index .Config.Labels "org.opencontainers.image.revision"}}', image)
    version = inspect("image", "inspect", "-f", '{{index .Config.Labels "org.opencontainers.image.version"}}', image)
    candidates[ref] = {"container": f"{image} {image_id} {state}", "image": image, "image_id": image_id,
                       "label_revision": revision, "label_version": version or revision[:12],
                       "release_id": image.split(":", 1)[1]}
    if state != "running" or not revision.startswith(image.split(":", 1)[1]):
        raise SystemExit(f"{ref}: container not running or image tag does not match its revision label")
proof = {"candidates": candidates, "contract_version": "evalos-deployment-attestation/1.0",
         "method": "read_only_docker_image_and_container_inspect_on_product_host",
         "observed_at": datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z")}
with open(sys.argv[1], "w") as handle:
    json.dump(proof, handle, indent=2, sort_keys=True)
    handle.write("\n")
PY
chmod 0444 "$F"
echo "proof=$F"
echo "sha256=$(sha256sum "$F" | cut -d' ' -f1)"
cat "$F"
