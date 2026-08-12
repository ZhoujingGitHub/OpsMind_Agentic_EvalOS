import { createHash, randomUUID } from "node:crypto";

export function stableStringify(value) {
  const normalize = (input) => {
    if (Array.isArray(input)) return input.map(normalize);
    if (input && typeof input === "object") {
      return Object.fromEntries(
        Object.keys(input)
          .sort()
          .filter((key) => input[key] !== undefined)
          .map((key) => [key, normalize(input[key])]),
      );
    }
    return input;
  };
  return JSON.stringify(normalize(value));
}

export function sha256(value) {
  const input = typeof value === "string" ? value : stableStringify(value);
  return createHash("sha256").update(input).digest("hex");
}

export function entityId(prefix, material = randomUUID()) {
  return `${prefix}_${sha256(String(material)).slice(0, 20)}`;
}

export function isoNow(clock = Date) {
  return new clock().toISOString();
}

export function seedFromString(value) {
  return Number.parseInt(sha256(String(value)).slice(0, 8), 16) >>> 0;
}

export function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let result = state;
    result = Math.imul(result ^ (result >>> 15), result | 1);
    result ^= result + Math.imul(result ^ (result >>> 7), result | 61);
    return ((result ^ (result >>> 14)) >>> 0) / 4294967296;
  };
}

export function seededShuffle(items, seed) {
  const output = [...items];
  const random = mulberry32(seed >>> 0);
  for (let index = output.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [output[index], output[swap]] = [output[swap], output[index]];
  }
  return output;
}

export function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function parseJson(value, fallback = null) {
  if (value === null || value === undefined || value === "") return fallback;
  return JSON.parse(value);
}

