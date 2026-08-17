const SENSITIVE_KEY = /(api[_-]?key|access[_-]?key|secret|password|passwd|token|authorization|cookie|private[_-]?key)/i;
const VALUE_PATTERNS = [
  // Require credential-like entropy/length. Human-facing source strings such
  // as "Bearer token required" are protocol documentation, not credentials.
  /\bBearer\s+(?:(?=[A-Za-z0-9._~+\/-]{16,}={0,2}(?:\s|["'`,;)}\]]|$))(?=[A-Za-z0-9._~+\/-]*[0-9._~+\/-])[A-Za-z0-9._~+\/-]+={0,2}|[A-Za-z]{32,})/gi,
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{8,}\b/g,
  /\bAKID[A-Za-z0-9]{12,}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

function redactString(value) {
  let output = value;
  for (const pattern of VALUE_PATTERNS) output = output.replace(pattern, "[REDACTED]");
  return output;
}

export function redact(value) {
  let changed = false;
  const visit = (input, key = "") => {
    const safeUsageCounter = /(?:^|_)input_tokens$|(?:^|_)output_tokens$/i.test(key)
      && (typeof input === "number" || (typeof input === "string" && /^\d+(?:\.\d+)?$/.test(input)));
    if (SENSITIVE_KEY.test(key) && !safeUsageCounter) {
      changed = true;
      return "[REDACTED]";
    }
    if (Array.isArray(input)) return input.map((item) => visit(item));
    if (input && typeof input === "object") {
      return Object.fromEntries(Object.entries(input).map(([childKey, child]) => [childKey, visit(child, childKey)]));
    }
    if (typeof input === "string") {
      const output = redactString(input);
      if (output !== input) changed = true;
      return output;
    }
    return input;
  };
  return { value: visit(value), changed };
}

export function containsSensitiveMaterial(value) {
  const serialized = JSON.stringify(value);
  return VALUE_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(serialized);
  });
}
