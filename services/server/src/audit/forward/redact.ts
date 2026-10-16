import type { AuditForwardingConfig } from "./config.js";

const REDACTED = "[redacted]";
/** Shorter values would redact ordinary words ("a", "on"); real credentials are longer. */
const MIN_SECRET_LENGTH = 4;

/**
 * A URL: scheme, optional userinfo (greedy, so up to the LAST "@" before the host: a password may
 * hold an unencoded "@"), host[:port], then path, query and fragment. Closing brackets, quotes and
 * commas end it, so prose around a URL survives.
 */
const URL_PATTERN =
  /\b([a-z][a-z0-9+.-]*:\/\/)(?:([^\s/?#]*)@)?([^\s/?#@)\]'",]+)([/?#][^\s)\]'",]*)?/gi;
/** "Bearer <token>" / "Basic <base64>" as an Authorization header or a client quotes it. */
const AUTH_CREDENTIAL = /\b(Bearer|bearer|Basic|basic)\s+([A-Za-z0-9._~+/-]+=*)/g;

/**
 * Plausible credential, not a word: at least 6 characters with a digit or a token symbol, or a
 * capital after the first letter (base64). "Basic constraints" and "Bearer token" stay.
 */
function looksLikeCredential(token: string): boolean {
  if (token.length < 6) return false;
  return /[0-9+/=._~-]/.test(token) || (/[a-z]/.test(token) && /[A-Z]/.test(token.slice(1)));
}

function redactUrl(scheme: string, userinfo: string | undefined, host: string, rest = ""): string {
  const who = userinfo === undefined ? "" : `${REDACTED}@`;
  const tail = rest === "" || rest === "/" ? rest : `/${REDACTED}`;
  return `${scheme}${who}${host}${tail}`;
}

/**
 * Removes credentials from a forwarding error before it is stored, logged or shown in the admin
 * health view (KOBE-182). Every configured secret (OTLP header values, URL credentials) goes first;
 * then every URL keeps only scheme://host[:port] (userinfo, path tokens and query strings go), and
 * bearer/basic credentials go. `fetch`, for one, quotes the whole URL, userinfo included, when it
 * refuses one with credentials.
 */
export function redactForwardingError(message: string, secrets: readonly string[] = []): string {
  const withoutSecrets = [...secrets]
    .filter((s) => s.length >= MIN_SECRET_LENGTH)
    .sort((a, b) => b.length - a.length)
    .reduce((text, secret) => text.split(secret).join(REDACTED), message);
  return withoutSecrets
    .replace(
      URL_PATTERN,
      (_m, scheme: string, userinfo: string | undefined, host: string, rest?: string) =>
        redactUrl(scheme, userinfo, host, rest),
    )
    .replace(AUTH_CREDENTIAL, (match, scheme: string, token: string) =>
      looksLikeCredential(token) ? `${scheme} ${REDACTED}` : match,
    );
}

function decoded(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** The configured values an error must never echo: OTLP header values and URL credentials. */
export function forwardingSecrets(config: AuditForwardingConfig): string[] {
  const secrets = new Set<string>();
  for (const value of Object.values(config.otlp?.headers ?? {})) {
    secrets.add(value);
    // "Bearer <token>": the token alone may be quoted too.
    const token = /^\S+\s+(\S+)$/.exec(value)?.[1];
    if (token) secrets.add(token);
  }
  if (config.otlp && URL.canParse(config.otlp.url)) {
    const { username, password } = new URL(config.otlp.url);
    for (const part of [username, password]) {
      if (part) {
        secrets.add(part);
        secrets.add(decoded(part));
      }
    }
  }
  return [...secrets].filter((s) => s.length >= MIN_SECRET_LENGTH);
}
