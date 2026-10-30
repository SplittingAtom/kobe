/**
 * Runs once when the web server starts (Next's instrumentation hook). KOBE-500: say whether the
 * server URL for the site branding is configured, so a missing `KOBE_SERVER_URL` is one clear
 * line at startup rather than a surprise later (the web keeps serving with the Kobe defaults). An
 * invalid one throws here and fails the start (lib/config.ts). KOBE-530: every HTML response gets
 * a Server-Timing header (lib/telemetry/server-timing.ts), installed here once per process.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { installServerTiming } = await import("./lib/telemetry/server-timing");
  installServerTiming();
  const { webConfig } = await import("./lib/config");
  const config = webConfig();
  if (config.problem !== null) console.warn(`[kobe-web] ${config.problem}`);
  else console.info(`[kobe-web] site branding from ${config.serverUrl}`);
}
