import type { AuditForwardingConfig } from "./config.js";

const REDACTED = "[redacted]";
/** Shorter values would redact ordinary words ("a", "on"); real credentials are longer. */
const MIN_SECRET_LENGTH = 4;

/** scheme://userinfo@ — userinfo cannot contain "/", "?", "#" or whitespace unencoded. */
const URL_USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@]+@/gi;
/** The query and fragment of a URL: tokens often travel there (`?api_key=`). */
const URL_QUERY = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s?#]*)[?#]\S*/gi;
const AUTH_TOKEN = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi;

/**
 * Removes credentials from a forwarding error before it is stored, logged or shown in the admin
 * health view (KOBE-182): URL userinfo, query strings, bearer/basic tokens and every configured
 * secret (OTLP header values, URL credentials). `fetch`, for one, quotes the whole URL, userinfo
 * included, when it refuses one with credentials.
 */
export function redactForwardingError(message: string, secrets: readonly string[] = []): string {
  const withoutSecrets = [...secrets]
    .filter((s) => s.length >= MIN_SECRET_LENGTH)
    .sort((a, b) => b.length - a.length)
    .reduce((text, secret) => text.split(secret).join(REDACTED), message);
  return withoutSecrets
    .replace(URL_USERINFO, `$1${REDACTED}@`)
    .replace(URL_QUERY, `$1?${REDACTED}`)
    .replace(AUTH_TOKEN, `$1 ${REDACTED}`);
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
