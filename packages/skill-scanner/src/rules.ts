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
    pattern: new RegExp(
      String.raw`\b${FETCH}\b[^|\n]{0,500}\|&?\s*(?:sudo\s+(?:-\S+\s+)*)?${SHELL}\b`,
    ),
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
      String.raw`\bbase64\s+(?:-d|-D|--decode)\b[^|\n]{0,500}\|\s*(?:sudo\s+)?(?:${SHELL}|python3?|perl|node)\b`,
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
  /**
   * The token's fixed-length core for text whose separators were removed (KOBE-379 review M-4:
   * a token split by spaces, hyphens or dots). Only rules anchored on a literal prefix have one;
   * a match also needs {@link plausibleSplitToken}. Used by {@link matchSplitSecret}.
   */
  readonly split?: RegExp;
}

/** Characters of a password-like value written without quotes (prose, `.env` lines, URLs). */
const BARE_VALUE = String.raw`[^\s"'\x60()[\]{}<>$,;]`;

export const SECRET_RULES: readonly SecretRule[] = [
  {
    id: "aws-access-key",
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
    group: 0,
    split: /(?:AKIA|ASIA)[0-9A-Z]{16}/g,
  },
  {
    id: "github-token",
    pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{50,}/,
    group: 0,
    split: /gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{50}/g,
  },
  {
    id: "private-key",
    pattern: /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/,
    group: 0,
  },
  {
    id: "slack-token",
    pattern: /\bx(?:ox[abprs]|app)-[A-Za-z0-9-]{10,}/,
    group: 0,
    split: /x(?:ox[abprs]|app)[A-Za-z0-9]{20}/g,
  },
  {
    id: "stripe-key",
    pattern: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}|\bwhsec_[A-Za-z0-9]{24,}/,
    group: 0,
    split: /(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16}|whsec_[A-Za-z0-9]{24}/g,
  },
  {
    id: "gitlab-token",
    pattern: /\bgl(?:pat|dt|rt|ptt|cbt|oas|ft|imt|agent)-[A-Za-z0-9_-]{20,}/,
    group: 0,
    split: /gl(?:pat|dt|rt|ptt|cbt|oas|ft|imt|agent)[A-Za-z0-9_]{20}/g,
  },
  {
    id: "api-key",
    pattern: /\bsk-(?:ant-)?[A-Za-z0-9_-]{32,}/,
    group: 0,
    split: /sk(?:ant)?[A-Za-z0-9_]{32}/g,
  },
  {
    id: "google-api-key",
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/,
    group: 0,
    split: /AIza[0-9A-Za-z_]{30}/g,
  },
  {
    // A JSON Web Token: three base64url segments, the first two JSON objects (`{"` = `eyJ`).
    id: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
    group: 0,
  },
  {
    id: "azure-account-key",
    pattern: /\b(?:AccountKey|SharedAccessKey)=[A-Za-z0-9+/]{40,}={0,2}/,
    group: 0,
  },
  {
    // A password in a URL's user info: `postgres://admin:S3cret@db:5432/app`.
    id: "connection-string",
    pattern: new RegExp(
      String.raw`\b[A-Za-z][A-Za-z0-9+.-]{1,20}://[^\s:/@]{1,64}:([^\s/@]{6,128})@`,
    ),
    group: 1,
  },
  {
    id: "generic-assignment",
    pattern:
      /\b(?:api[_-]?key|secret|token|passw(?:or)?d|auth)\w*["']?\s*[:=]\s*["']([A-Za-z0-9+/_.-]{20,})["']/i,
    group: 1,
  },
  {
    // Unquoted: `password = Hunter2…`, `DB_PASSWORD=…`, `pwd: …`, "the password is …".
    id: "password-unquoted",
    pattern: new RegExp(
      String.raw`(?<![A-Za-z0-9])(?:passw(?:or)?d|pwd|secret|token|api[_ -]?key|access[_ -]?key)\w{0,20}["']?(?:[ \t]{0,3}[:=][ \t]{0,3}|[ \t]{1,3}is[ \t]{1,3}(?::[ \t]{0,3})?)(${BARE_VALUE}{8,128})`,
      "i",
    ),
    group: 1,
  },
];

const PLACEHOLDER = /example|changeme|placeholder|xxxx|your[_-]|dummy|sample/i;
/** `config.api_key_v2`, `process.env.TOKEN2`: a reference in code, not a value. */
const DOTTED_IDENTIFIER = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/;

/** Generic assignments need a mixed letter/digit value that does not look like a placeholder. */
export function plausibleSecret(value: string): boolean {
  return (
    /[A-Za-z]/.test(value) &&
    /\d/.test(value) &&
    !PLACEHOLDER.test(value) &&
    !DOTTED_IDENTIFIER.test(value)
  );
}

/**
 * A token found only after separators were removed: it must have a digit and no run of nine or
 * more lower-case letters (joined prose words: "prefixmarksgithub"), which random tokens rarely
 * carry.
 */
export function plausibleSplitToken(token: string): boolean {
  return /\d/.test(token) && !/[a-z]{9}/.test(token) && !PLACEHOLDER.test(token);
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
