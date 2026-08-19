export type LogLevel = "info" | "warn" | "error";

export type SafeLogRecord = Readonly<{
  timestamp: string;
  level: LogLevel;
  event: string;
  context: unknown;
}>;

const REDACTED = "[REDACTED]";
const ACCESSOR_REDACTED = "[ACCESSOR_REDACTED]";
const UNSERIALIZABLE_REDACTED = "[UNSERIALIZABLE_REDACTED]";
const MAX_DEPTH = 5;
const MAX_ARRAY_ITEMS = 50;
const MAX_OBJECT_KEYS = 75;
const SAFE_EVENT_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,79}$/;

const SENSITIVE_KEY_PATTERN =
  /(?:authorization|bearer|cookie|password|secret|token|signature|session|payload|body|email|phone|contact|recipient|destination|address|name|value|handle|identifier|username|profile|instagram|linkedin)/i;

const INLINE_SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g,
  /Bearer\s+[^\s,;]+/gi,
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9_-]+\b/g,
  /\bwhsec_[A-Za-z0-9_-]+\b/g,
  /\bsb_secret_[A-Za-z0-9_-]+\b/g,
  /\bscrypt-v1\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+\b/g,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
  /\bmt_[A-Za-z0-9_-]{43}\b/g,
  /\bmi_[A-Za-z0-9_-]{43}\b/g,
  /\bmarat-checkin:[A-Za-z0-9_-]{43}\b/g,
  /\b[A-Za-z0-9_-]{40,}\b/g,
  /\b(?:token|secret|signature|key)=([^\s&#]+)/gi,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
  /(^|\s)@[A-Za-z0-9._]{1,32}\b/g,
  /(?:\+?\d[\s().-]*){7,}/g,
];

function redactString(value: string): string {
  let redacted = value;
  for (const pattern of INLINE_SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, REDACTED);
  }
  return redacted.length > 2_000 ? `${redacted.slice(0, 2_000)}[TRUNCATED]` : redacted;
}

function redactValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return value;
  }

  if (typeof value === "string") {
    return redactString(value);
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol") {
    return undefined;
  }

  if (value instanceof Error) {
    return { name: value.name, details: REDACTED };
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? "[INVALID_DATE]" : value.toISOString();
  }

  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    return "[BINARY_REDACTED]";
  }

  if (depth >= MAX_DEPTH) {
    return "[MAX_DEPTH]";
  }

  if (seen.has(value)) {
    return "[CIRCULAR]";
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_ARRAY_ITEMS)
      .map((item) => redactValue(item, depth + 1, seen));
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return "[NON_PLAIN_OBJECT_REDACTED]";
  }

  const output: Record<string, unknown> = {};
  const descriptors = Object.entries(Object.getOwnPropertyDescriptors(value))
    .filter(([, descriptor]) => descriptor.enumerable)
    .slice(0, MAX_OBJECT_KEYS);
  for (const [key, descriptor] of descriptors) {
    const child = "value" in descriptor
      ? descriptor.value
      : ACCESSOR_REDACTED;
    const safeChild = SENSITIVE_KEY_PATTERN.test(key)
      ? REDACTED
      : redactValue(child, depth + 1, seen);
    Object.defineProperty(output, key, {
      value: safeChild,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return output;
}

export function redactForLog(value: unknown): unknown {
  try {
    return redactValue(value, 0, new WeakSet<object>());
  } catch {
    return UNSERIALIZABLE_REDACTED;
  }
}

export function createSafeLogRecord(
  level: LogLevel,
  event: string,
  context: unknown = {},
  now: () => Date = () => new Date(),
): SafeLogRecord {
  return {
    timestamp: now().toISOString(),
    level,
    event: SAFE_EVENT_PATTERN.test(event) ? event : "invalid_log_event",
    context: redactForLog(context),
  };
}
