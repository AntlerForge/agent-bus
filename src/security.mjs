const SECRET_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/i,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\b(?:api[_-]?key|access[_-]?token|secret)\s*[:=]\s*["']?[A-Za-z0-9_./+=-]{16,}/i,
];

export function assertNoObviousSecrets(...values) {
  const text = values.filter((value) => typeof value === "string").join("\n");
  const matched = SECRET_PATTERNS.find((pattern) => pattern.test(text));
  if (matched) {
    throw new Error("Message appears to contain a secret, token, or private key. Remove it before sending.");
  }
}
