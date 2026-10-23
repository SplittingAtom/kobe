/**
 * The web build's identity (KOBE-487). `next.config.ts` resolves it once per `next build` and
 * inlines it as `process.env.KOBE_BUILD_ID` into the client bundle and the server code alike, so
 * a page knows the build it was loaded from and `/api/build` reports the build now serving.
 * Image builds may pass one (`docker build --build-arg KOBE_BUILD_ID=local-<sha12>`); otherwise
 * every build makes a fresh one, so each new web image has a new id either way.
 */

/** Where the build inlined no id: vitest, or code read outside `next build`/`next dev`. */
export const DEV_BUILD_ID = "dev";

const BUILD_ID = /^[A-Za-z0-9._-]{1,64}$/;

/** The page's own build id, inlined at build time. */
export const CLIENT_BUILD_ID: string = process.env.KOBE_BUILD_ID ?? DEV_BUILD_ID;

/** The id for this build: the one passed in, or a new random one. */
export function resolveBuildId(env: Readonly<Record<string, string | undefined>>): string {
  const given = env.KOBE_BUILD_ID?.trim();
  if (given === undefined || given === "") return freshBuildId();
  if (!BUILD_ID.test(given)) {
    throw new Error(
      `KOBE_BUILD_ID must be 1-64 of A-Z a-z 0-9 . _ - (got ${JSON.stringify(given)})`,
    );
  }
  return given;
}

function freshBuildId(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(4));
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${Date.now().toString(36)}-${hex}`;
}
