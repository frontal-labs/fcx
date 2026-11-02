interface SecretPattern {
  name: string;
  pattern: RegExp;
}

// Common secret shapes. Matching text is never stored or echoed back in errors.
const SECRET_PATTERNS: readonly SecretPattern[] = [
  { name: "private key", pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/ },
  { name: "bearer token", pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/i },
  { name: "anthropic or openai key", pattern: /\bsk-[A-Za-z0-9_-]{16,}/ },
  { name: "aws access key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: "github token", pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { name: "google api key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: "slack token", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  {
    name: "credential assignment",
    pattern:
      /\b(?:api[_-]?key|secret|token|password|passwd)\b["']?\s*[:=]\s*["']?[A-Za-z0-9_\-/+=.]{12,}/i,
  },
];

/** Returns the name of the first secret pattern that matches, or null. */
export function detectSecret(text: string): string | null {
  for (const { name, pattern } of SECRET_PATTERNS) {
    if (pattern.test(text)) {
      return name;
    }
  }
  return null;
}
