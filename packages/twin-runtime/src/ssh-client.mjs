import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { validateTwinRequest, validateTwinResponse } from "./contracts.mjs";

const execFileAsync = promisify(execFile);
const SAFE_HOST = /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9.-]{0,251}[a-zA-Z0-9])?|(?:\d{1,3}\.){3}\d{1,3})$/;
const SAFE_USER = /^[a-z_][a-z0-9_-]{0,31}$/;
const SAFE_COMMAND = /^\/[a-zA-Z0-9_./-]+$/;

export class SshTwinClient {
  constructor({
    host = process.env.EVALOS_TWIN_HOST,
    user = process.env.EVALOS_TWIN_USER ?? "evalos-twin",
    privateKeyPath = process.env.EVALOS_TWIN_SSH_KEY,
    knownHostsPath = process.env.EVALOS_TWIN_KNOWN_HOSTS,
    command = process.env.EVALOS_TWIN_COMMAND ?? "/usr/local/sbin/opsmind-twinctl",
    useSudo = process.env.EVALOS_TWIN_USE_SUDO !== "0",
    port = Number(process.env.EVALOS_TWIN_SSH_PORT ?? 22),
    timeoutMs = 120000,
  } = {}) {
    if (!SAFE_HOST.test(String(host ?? ""))) throw new Error("EVALOS_TWIN_HOST is required and must be a host name or IP address");
    if (!SAFE_USER.test(String(user))) throw new Error("Invalid EVALOS_TWIN_USER");
    if (!privateKeyPath) throw new Error("EVALOS_TWIN_SSH_KEY is required");
    if (!knownHostsPath) throw new Error("EVALOS_TWIN_KNOWN_HOSTS is required");
    if (!SAFE_COMMAND.test(String(command))) throw new Error("Invalid EVALOS_TWIN_COMMAND");
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid Twin SSH port");
    this.options = Object.freeze({ host, user, privateKeyPath, knownHostsPath, command, useSudo, port, timeoutMs });
  }

  async invoke(rawRequest) {
    const request = validateTwinRequest(rawRequest);
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
      const structured = parseResponse(error.stdout, request.operation);
      if (structured) return structured;
      const detail = String(error.stderr ?? error.message ?? "Twin SSH request failed").trim();
      throw new Error(`Twin SSH request failed: ${detail.slice(0, 500)}`);
    }
    const response = parseResponse(stdout, request.operation);
    if (!response) throw new Error("Twin controller returned non-JSON output");
    return response;
  }
}

function parseResponse(stdout, operation) {
  const lines = String(stdout ?? "").trim().split(/\r?\n/).filter(Boolean);
  try { return validateTwinResponse(JSON.parse(lines.at(-1) ?? ""), operation); }
  catch { return null; }
}
