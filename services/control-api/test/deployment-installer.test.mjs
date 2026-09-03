import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "../../..");
const installer = readFileSync(path.join(root, "infra/deploy/install-m31-release.sh"), "utf8").replaceAll("\r\n", "\n");
const doubles = readFileSync(new URL("./fixtures/installer-sandbox.sh", import.meta.url), "utf8").replaceAll("\r\n", "\n");
const releaseId = "m31-20260903-1111111111";
const previousId = "m31-20260902-2222222222";
const bash = process.platform === "win32"
  ? path.resolve(path.dirname(execFileSync("where.exe", ["git"], { encoding: "utf8" }).trim().split(/\r?\n/)[0]), "../bin/bash.exe")
  : "bash";
const posix = value => value.replaceAll("\\", "/").replace(/^([A-Za-z]):/, (_, letter) => "/" + letter.toLowerCase());

function runInstaller(t, failure = "", recoveryFailure = "") {
  const directory = mkdtempSync(path.join(tmpdir(), "evalos-install-test-"));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith("evalos-install-test-"));
    rmSync(directory, { recursive: true, force: true });
  });
  const fixture = posix(directory);
  const put = (relative, value) => {
    const file = path.join(directory, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, value);
  };
  const read = relative => readFileSync(path.join(directory, relative), "utf8").trim();
  const current = "opt/opsmind-evalos/current";
  const previous = "opt/opsmind-evalos/previous";
  mkdirSync(path.join(directory, "opt/opsmind-evalos/releases", previousId), { recursive: true });
  put(current, fixture + "/opt/opsmind-evalos/releases/" + previousId + "\n");
  put(previous, "older-rollback-point\n");
  put("service-state", "running");
  put("events", "");
  put("archive.tgz", "test-only archive");
  const databases = ["control/control.sqlite", "private/labels.sqlite"];
  for (const file of databases) {
    put("var/lib/opsmind-evalos/" + file, "current-records");
    put("var/lib/opsmind-evalos/" + file + "-wal", "live-wal");
  }
  for (const file of ["opsmind-evalos.service", "opsmind-evalos-console.service"]) {
    put("etc/systemd/system/" + file, "old-unit");
    put("package/evalos/infra/systemd/" + file, "new-unit");
  }
  put("etc/nginx/sites-available/opsmind-evalos", "old-nginx");
  put("package/evalos/infra/nginx/opsmind-evalos.conf", "new-nginx");
  put("package/evalos/config/candidate-presence-public-keys.json", "{}");
  put("package/evalos/RELEASE.json", JSON.stringify({
    contract: "evalos-release.2", release_id: releaseId, source_revision: "a".repeat(40),
    content_digest: "sha256:" + "b".repeat(64), includes_external_candidate_source: false, formal_480_enabled: false,
  }, null, 2));
  if (failure === "duplicate") {
    mkdirSync(path.join(directory, "opt/opsmind-evalos/releases", releaseId), { recursive: true });
    // Old same-name backups must not overwrite current records after early rejection.
    for (const file of databases) put("var/lib/opsmind-evalos/backups/" + releaseId + "/" + file, "stale-backup");
  }
  if (failure === "missing-previous") rmSync(path.join(directory, current));
  if (failure === "metadata") put("package/evalos/RELEASE.json", "{}");
  const hash = createHash("sha256").update("test-only archive").digest("hex");
  // Test-only path rebasing; production installer retains its fixed approved paths.
  const rebased = installer.replace(/\/(?:opt\/opsmind-evalos|var\/lib\/opsmind-evalos|etc\/systemd\/system|etc\/nginx\/sites-available)/g,
    match => fixture + match);
  const result = spawnSync(bash, ["--noprofile", "--norc", "-s", "--",
    fixture + "/archive.tgz", releaseId, failure === "checksum" ? "bad" : hash], {
    input: doubles + "\n" + rebased, encoding: "utf8", timeout: 20000,
    env: { ...process.env, fixture, failure, recovery_failure: recoveryFailure, BASH_ENV: "", ENV: "" },
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return { result, read, directory, fixture, current, previous, databases };
}

for (const failure of ["checksum", "duplicate", "missing-previous", "disk", "unpack", "metadata", "dependencies", "config-backup"]) {
  test("安装前失败不动现有服务或数据库：" + failure, t => {
    const state = runInstaller(t, failure);
    assert.notEqual(state.result.status, 0);
    assert.doesNotMatch(state.read("events"), /systemctl|nginx/);
    assert.equal(state.read("service-state"), "running");
    for (const file of state.databases) assert.equal(state.read("var/lib/opsmind-evalos/" + file), "current-records");
    assert.equal(state.read(state.previous), "older-rollback-point");
  });
}

for (const failure of ["stop", "database-backup", "install", "nginx", "switch", "reload", "start", "readiness", "smoke"]) {
  test("切换期间失败只退应用且保留数据库：" + failure, t => {
    const state = runInstaller(t, failure);
    assert.equal(state.result.status, failure === "readiness" ? 1 : 37, state.result.stderr);
    assert.equal(state.read(state.current), state.fixture + "/opt/opsmind-evalos/releases/" + previousId);
    assert.equal(state.read(state.previous), "older-rollback-point");
    assert.equal(state.read("etc/systemd/system/opsmind-evalos.service"), "old-unit");
    assert.equal(state.read("etc/systemd/system/opsmind-evalos-console.service"), "old-unit");
    assert.equal(state.read("etc/nginx/sites-available/opsmind-evalos"), "old-nginx");
    assert.equal(state.read("service-state"), "running");
    for (const file of state.databases) {
      const expected = ["start", "readiness", "smoke"].includes(failure) ? "current-records\nnew-record" : "current-records";
      assert.equal(state.read("var/lib/opsmind-evalos/" + file), expected);
      assert.equal(state.read("var/lib/opsmind-evalos/" + file + "-wal"), "live-wal");
    }
    assert.match(state.result.stderr, /database unchanged/);
  });
}

for (const recoveryFailure of ["pointer", "config", "start"]) {
  test("应用恢复失败必须明说且保留原始退出码：" + recoveryFailure, t => {
    const state = runInstaller(t, "smoke", recoveryFailure);
    assert.equal(state.result.status, 37);
    assert.match(state.result.stderr, /recovery incomplete/);
    assert.doesNotMatch(state.result.stderr, /application restored/);
    for (const file of state.databases) assert.equal(state.read("var/lib/opsmind-evalos/" + file), "current-records\nnew-record");
    assert.equal(state.read("service-state"), "stopped");
  });
}

test("安装成功保留前后版本与备份，不执行失败恢复", t => {
  const state = runInstaller(t);
  assert.equal(state.result.status, 0, state.result.stderr);
  assert.equal(state.read(state.current), state.fixture + "/opt/opsmind-evalos/releases/" + releaseId);
  assert.equal(state.read(state.previous), state.fixture + "/opt/opsmind-evalos/releases/" + previousId);
  assert.equal(state.read("etc/systemd/system/opsmind-evalos.service"), "new-unit");
  assert.equal(state.read("service-state"), "running");
  for (const file of state.databases) {
    assert.equal(state.read("var/lib/opsmind-evalos/" + file), "current-records\nnew-record");
    assert.equal(state.read("var/lib/opsmind-evalos/backups/" + releaseId + "/" + file), "current-records");
  }
  assert.doesNotMatch(state.result.stderr, /restor|recovery/);
});
