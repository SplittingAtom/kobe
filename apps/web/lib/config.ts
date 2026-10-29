import { z } from "zod";

/**
 * The web's server-side configuration (KOBE-500, theming plan TH5). The web runs without it:
 * an unset or invalid `KOBE_SERVER_URL` only means the site branding falls back to the built-in
 * defaults (lib/theme/branding-server.ts), so this never throws. `instrumentation.ts` prints the
 * outcome once at startup.
 *
 * `KOBE_SERVER_URL` is the server's in-cluster origin (chart: `http://<fullname>-server`), set by
 * the deployment, never taken from a request.
 */
export interface WebConfig {
  /** The server's origin (`http(s)://host[:port]`, no path), or null when unset or invalid. */
  readonly serverUrl: string | null;
  /** Why `serverUrl` is null, for the startup log; null when it is set. */
  readonly problem: string | null;
}

const serverUrlSchema = z.url({ protocol: /^https?$/ }).refine((value) => {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return (
    url.username === "" &&
    url.password === "" &&
    (url.pathname === "/" || url.pathname === "") &&
    url.search === "" &&
    url.hash === ""
  );
}, "must be an origin only (http(s)://host[:port], no path, query or credentials)");

export function parseWebConfig(env: Readonly<Record<string, string | undefined>>): WebConfig {
  const raw = env.KOBE_SERVER_URL?.trim() ?? "";
  if (raw === "") {
    return {
      serverUrl: null,
      problem:
        "KOBE_SERVER_URL is not set: the site branding (name, logo, theme) falls back to the Kobe defaults",
    };
  }
  const parsed = serverUrlSchema.safeParse(raw);
  if (!parsed.success) {
    const reason = parsed.error.issues[0]?.message ?? "invalid URL";
    return {
      serverUrl: null,
      problem: `KOBE_SERVER_URL is invalid (${reason}): the site branding falls back to the Kobe defaults`,
    };
  }
  return { serverUrl: new URL(parsed.data).origin, problem: null };
}

let cached: WebConfig | undefined;

/** The process's configuration, read once. */
export function webConfig(): WebConfig {
  cached ??= parseWebConfig(process.env);
  return cached;
}

/** Tests only: read the environment again on the next call. */
export function resetWebConfigForTests(): void {
  cached = undefined;
}
