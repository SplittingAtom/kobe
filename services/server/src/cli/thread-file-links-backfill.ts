import { createDb } from "@kobe/db";
import { backfillThreadFileLinks } from "../thread-file-links/backfill.js";
import { parseBackfillArgs } from "./thread-file-links-backfill-args.js";
import { exitSoon } from "./replica.js";

// Operator tool (KOBE-610, TFM3), run once inside a server pod after the upgrade (its env):
//   node dist/cli/thread-file-links-backfill.js [--restart] [--max <threads>] [--pace-ms <ms>]
// Records thread–file links from what existing threads already store (file tool calls in their
// entries, attachments, project commits). Idempotent and resumable: it continues after the last
// thread it finished (cursor in site_settings), `--max` stops after that many threads, `--restart`
// walks everything again (changes nothing already recorded). Prints counts as one JSON line, never
// paths. Exit 0 when every thread is done, 1 when stopped by `--max`, 2 on a usage error.
async function main(): Promise<number> {
  const options = parseBackfillArgs(process.argv.slice(2));
  if (typeof options === "string") {
    console.error(options);
    return 2;
  }
  const databaseUrl = process.env.KOBE_DATABASE_URL;
  if (!databaseUrl) {
    console.error("KOBE_DATABASE_URL is not set");
    return 2;
  }
  const database = createDb(databaseUrl, { max: 2 });
  try {
    const result = await backfillThreadFileLinks(database.db, options);
    console.log(JSON.stringify(result));
    return result.done ? 0 : 1;
  } finally {
    await database.close();
  }
}

main().then(exitSoon, (err: unknown) => {
  console.error(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
  exitSoon(2);
});
