import type { FindingCategory } from "./types.js";

export interface Rule {
  readonly category: Exclude<FindingCategory, "secret">;
  readonly id: string;
  readonly pattern: RegExp;
}

// All patterns are linear: no nested quantifiers, and unbounded gaps never overlap their
// neighbours. Callers also cap the input line length.
const SHELL = String.raw`(?:ba|z|da|k)?sh`;
const FETCH = String.raw`(?:curl|wget)`;
const DECODE = String.raw`(?:atob|b64decode|base64|fromhex|unhexlify|decodeURIComponent|decompress)`;

export const SCRIPT_RULES: readonly Rule[] = [
  {
    category: "pipe-to-shell",
    id: "fetch-pipe-shell",
    pattern: new RegExp(String.raw`\b${FETCH}\b[^|\n]*\|&?\s*(?:sudo\s+(?:-\S+\s+)*)?${SHELL}\b`),
  },
  {
    category: "pipe-to-shell",
    id: "shell-process-subst",
    pattern: new RegExp(String.raw`\b${SHELL}\s+<\(\s*${FETCH}\b`),
  },
  {
    category: "pipe-to-shell",
    id: "shell-c-subst",
    pattern: new RegExp(String.raw`\b${SHELL}\s+-c\s+["']?\$\(\s*${FETCH}\b`),
  },

  { category: "network", id: "curl-wget", pattern: new RegExp(String.raw`\b${FETCH}\s`) },
  { category: "network", id: "fetch-call", pattern: /\bfetch\s*\(/ },
  {
    category: "network",
    id: "python-http",
    pattern:
      /\b(?:requests\.(?:get|post|put|patch|delete|head|request|Session)|urllib\.request|urlopen|httpx\.|aiohttp\.)/,
  },
  {
    category: "network",
    id: "node-http",
    pattern: /\b(?:https?\.(?:get|request)\s*\(|XMLHttpRequest|axios\b|new\s+WebSocket\s*\()/,
  },
  {
    category: "network",
    id: "socket",
    pattern: /\bsocket\.(?:socket|create_connection)\s*\(|\/dev\/tcp\//,
  },
  { category: "network", id: "netcat", pattern: /(?:^|[\s;&|(])(?:nc|ncat|netcat)\s+-?\w/ },

  {
    category: "package-install",
    id: "pip",
    pattern:
      /\b(?:pip3?|pipx|poetry|conda|mamba)\s+(?:install|add)\b|\bpip3?['"]\s*,\s*['"]install\b/,
  },
  {
    category: "package-install",
    id: "node-pm",
    pattern: /\b(?:npm|pnpm|yarn|bun)\s+(?:install|i|add)\b/,
  },
  {
    category: "package-install",
    id: "system-pm",
    pattern:
      /\b(?:apt|apt-get|aptitude|yum|dnf|apk|brew|zypper)\s+(?:-\S+\s+)*(?:install|add)\b|\bpacman\s+-S/,
  },
  { category: "package-install", id: "lang-pm", pattern: /\b(?:gem|cargo|go)\s+install\b/ },

  {
    category: "obfuscation",
    id: "decode-pipe-exec",
    pattern: new RegExp(
      String.raw`\bbase64\s+(?:-d|-D|--decode)\b[^|\n]*\|\s*(?:sudo\s+)?(?:${SHELL}|python3?|perl|node)\b`,
    ),
  },
  {
    category: "obfuscation",
    id: "eval-subst-decode",
    pattern: /\beval\s+["']?\$\([^)\n]{0,200}base64/,
  },
  {
    category: "obfuscation",
    id: "eval-decoded",
    pattern: new RegExp(String.raw`\b(?:eval|exec|Function|compile)\s*\(\s*[^)\n]{0,200}${DECODE}`),
  },
  {
    category: "obfuscation",
    id: "hex-escapes",
    pattern: /(?:\\x[0-9a-fA-F]{2}){16,}|(?:\\u[0-9a-fA-F]{4}){12,}/,
  },
];

export interface SecretRule {
  readonly id: string;
  readonly pattern: RegExp;
  /** Index of the capture group holding the secret value (0 = whole match). */
  readonly group: number;
}

export const SECRET_RULES: readonly SecretRule[] = [
  { id: "aws-access-key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/, group: 0 },
  {
    id: "github-token",
    pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{50,}/,
    group: 0,
  },
  { id: "private-key", pattern: /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/, group: 0 },
  { id: "slack-token", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/, group: 0 },
  { id: "api-key", pattern: /\bsk-(?:ant-)?[A-Za-z0-9_-]{32,}/, group: 0 },
  { id: "google-api-key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/, group: 0 },
  {
    id: "generic-assignment",
    pattern:
      /\b(?:api[_-]?key|secret|token|passw(?:or)?d|auth)\w*["']?\s*[:=]\s*["']([A-Za-z0-9+/_.-]{20,})["']/i,
    group: 1,
  },
];

const PLACEHOLDER = /example|changeme|placeholder|xxxx|your[_-]|dummy|sample/i;

/** Generic assignments need a mixed letter/digit value that does not look like a placeholder. */
export function plausibleSecret(value: string): boolean {
  return /[A-Za-z]/.test(value) && /\d/.test(value) && !PLACEHOLDER.test(value);
}

const STAGE_FETCH = /\b(?:curl|wget)\b/;
const STAGE_EXEC = /^&?\s*(?:sudo\s+(?:-\S+\s+)*)?(?:(?:ba|z|da|k)?sh|python3?|perl|ruby|node)\b/;

/**
 * True when a download appears in one pipeline stage and an interpreter reads a later stage.
 * Linear: one split on single pipes, then one pass over the stages.
 */
export function pipesDownloadToInterpreter(line: string): boolean {
  const stages = line.split(/(?<!\|)\|(?!\|)/);
  let seenFetch = false;
  for (const stage of stages) {
    if (seenFetch && STAGE_EXEC.test(stage)) return true;
    if (STAGE_FETCH.test(stage)) seenFetch = true;
  }
  return false;
}
