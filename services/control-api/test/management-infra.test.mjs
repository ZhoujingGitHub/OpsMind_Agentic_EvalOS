import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (relative) => readFileSync(path.join(root, relative), "utf8");

test("fixed management identity remains overlay-only and forced-command", () => {
  const installer = read("infra/management/install-evalos-management.sh");
  const entry = read("infra/management/opsmind-maint-entry.sh");

  assert.match(installer, /source_address="\$\{2:-10\.77\.240\.2\/32\}"/);
  assert.match(installer, /restrict,from="%s",command="\/usr\/local\/bin\/opsmind-maint-entry"/);
  assert.match(installer, /NOPASSWD: \/usr\/local\/sbin\/opsmind-evalos-maint \*/);
  assert.match(installer, /visudo -cf/);
  assert.match(installer, /sshd -t/);
  assert.match(entry, /exec sudo -n \/usr\/local\/sbin\/opsmind-evalos-maint/);
});

test("fixed management wrapper exposes only status upload deploy and application rollback", () => {
  const wrapper = read("infra/management/opsmind-evalos-maint.sh");

  assert.match(wrapper, /case "\$command_name" in/);
  assert.deepEqual([...wrapper.matchAll(/^  ([a-z]+)\)$/gm)].map((match) => match[1]),
    ["status", "upload", "deploy", "rollback"]);
  assert.match(wrapper, /command not allowed/);
  assert.doesNotMatch(wrapper, /\beval\b|bash -c|sh -c|SSH_ORIGINAL_COMMAND/);
  assert.match(wrapper, /archive exceeds 512 MiB safety limit/);
  assert.match(wrapper, /base64 --decode/);
  assert.match(wrapper, /base64 byte count mismatch/);
  assert.match(wrapper, /archive byte count mismatch/);
  assert.match(wrapper, /archive checksum mismatch/);
  assert.match(wrapper, /exec \/usr\/local\/sbin\/opsmind-evalos-install-release/);
  const rollback = wrapper.slice(wrapper.indexOf("  rollback)"), wrapper.indexOf("  *)"));
  assert.match(rollback, /previous_link/);
  assert.match(rollback, /database_action=none/);
  assert.doesNotMatch(rollback, /control\.sqlite|labels\.sqlite|backups|migration/i);
});
