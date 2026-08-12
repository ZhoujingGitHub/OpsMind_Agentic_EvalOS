const SENSITIVE_KEY = /(api[_-]?key|access[_-]?key|secret|password|passwd|token|authorization|cookie|private[_-]?key)/i;
const VALUE_PATTERNS = [
  /Bearer\s+[A-Za-z0-9._~+\/-]+=*/gi,
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
    if (SENSITIVE_KEY.test(key)) {
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

