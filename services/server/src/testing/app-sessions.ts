import pg from "pg";
import { testServerUrl } from "@kobe/db/testing";

/**
 * Pool#end resolves before its idle connections have closed; dropping the database WITH (FORCE)
 * meanwhile terminates them (57P01) on clients without an error listener. Waits until the server
 * sees none of `appRole`'s sessions, so a test file can drop its database cleanly.
 */
export async function waitForAppSessionsToClose(appRole: string): Promise<void> {
  const server = new pg.Client({ connectionString: testServerUrl() });
  await server.connect();
  try {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const { rows } = await server.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename = $1`,
        [appRole],
      );
      if (rows[0]?.n === 0) return;
      if (Date.now() > deadline) throw new Error("app-role sessions still open after 10 s");
      await new Promise((r) => setTimeout(r, 50));
    }
  } finally {
    await server.end();
  }
}
