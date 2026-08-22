import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { validateTwinManagerRequest, validateTwinManagerResponse } from "./contracts.mjs";

const execFileAsync = promisify(execFile);
const SAFE_HOST = /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9.-]{0,251}[a-zA-Z0-9])?|(?:\d{1,3}\.){3}\d{1,3})$/;
const SAFE_USER = /^[a-z_][a-z0-9_-]{0,31}$/;
const SAFE_COMMAND = /^\/[a-zA-Z0-9_./-]+$/;

export class SshTwinManagerClient {
  constructor({
    host = process.env.EVALOS_TWIN_HOST,
    user = process.env.EVALOS_TWIN_USER ?? "evalos-twin",
    privateKeyPath = process.env.EVALOS_TWIN_SSH_KEY,
    knownHostsPath = process.env.EVALOS_TWIN_KNOWN_HOSTS,
    command = process.env.EVALOS_TWIN_MANAGER_COMMAND ?? "/usr/local/sbin/opsmind-eval-manager",
    useSudo = process.env.EVALOS_TWIN_USE_SUDO !== "0",
    port = Number(process.env.EVALOS_TWIN_SSH_PORT ?? 22),
    timeoutMs = 180000,
  } = {}) {
    if (!SAFE_HOST.test(String(host ?? ""))) throw new Error("EVALOS_TWIN_HOST is required and must be a host name or IP address");
    if (!SAFE_USER.test(String(user))) throw new Error("Invalid EVALOS_TWIN_USER");
    if (!privateKeyPath) throw new Error("EVALOS_TWIN_SSH_KEY is required");
    if (!knownHostsPath) throw new Error("EVALOS_TWIN_KNOWN_HOSTS is required");
    if (!SAFE_COMMAND.test(String(command))) throw new Error("Invalid EVALOS_TWIN_MANAGER_COMMAND");
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid Twin manager SSH port");
    this.options = Object.freeze({ host, user, privateKeyPath, knownHostsPath, command, useSudo, port, timeoutMs });
  }

  async invoke(rawRequest) {
    const request = validateTwinManagerRequest(rawRequest);
    const encoded = Buffer.from(JSON.stringify(request), "utf8").toString("base64url");
    const { host, user, privateKeyPath, knownHostsPath, command, useSudo, port, timeoutMs } = this.options;
    const args = [
      "-T", "-p", String(port), "-i", privateKeyPath,
      "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-o", "StrictHostKeyChecking=yes",
      "-o", `UserKnownHostsFile=${knownHostsPath}`, "-o", "ConnectTimeout=10",
      `${user}@${host}`, `${useSudo ? "sudo " : ""}${command} request ${encoded}`,
    ];
    let stdout;
    try {
      ({ stdout } = await execFileAsync("ssh", args, { encoding: "utf8", timeout: timeoutMs, windowsHide: true,
        maxBuffer: 8 * 1024 * 1024 }));
    } catch (error) {
      const structured = parseManagerResponse(error.stdout, request.operation);
      if (structured) return structured;
      const detail = String(error.stderr ?? error.message ?? "Twin manager SSH request failed").trim();
      throw new Error(`Twin manager SSH request failed: ${detail.slice(0, 500)}`);
    }
    const response = parseManagerResponse(stdout, request.operation);
    if (!response) throw new Error("Twin manager returned non-JSON output");
    return response;
  }
}

function parseManagerResponse(stdout, operation) {
  const lines = String(stdout ?? "").trim().split(/\r?\n/).filter(Boolean);
  try { return validateTwinManagerResponse(JSON.parse(lines.at(-1) ?? ""), operation); }
  catch { return null; }
}
