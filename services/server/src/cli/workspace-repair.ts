import { createDb } from "@kobe/db";
import { logger } from "../logger.js";
import { createS3ObjectStore, loadS3Settings, repairWorkspaces } from "../workspace-sync/index.js";
import { exitSoon } from "./replica.js";
import { parseRepairArgs } from "./workspace-repair-args.js";

// Operator tool (KOBE-475), run inside a server pod (its env: database and object storage):
//   node dist/cli/workspace-repair.js [--dry-run] [--team-id <uuid> [--user-id <uuid>]]
//     [--max <workspaces>] [--pace-ms <ms>]
// One storage call at a time, `--pace-ms` (default 20) apart; `--max` stops after that many
// workspaces (run again for the rest).
// Checks every live workspace file against object storage and marks content that is missing
// "lost": each member's sandbox uploads it again at its next sync (push), verified against the
// recorded SHA-256 and size. Prints the counts as one JSON line; never paths or content.
// Exit 0 when nothing is missing (or everything missing is now marked), 1 on a dry run that found
// missing content, 2 on a usage or configuration error.
async function main(): Promise<number> {
  const args = parseRepairArgs(process.argv.slice(2));
  if (typeof args === "string") {
    console.error(args);
    return 2;
  }
  const databaseUrl = process.env.KOBE_DATABASE_URL;
  if (!databaseUrl) {
    console.error("KOBE_DATABASE_URL is not set");
    return 2;
  }
  const s3 = loadS3Settings(process.env);
  if (!s3) {
    console.error("object storage is not configured (KOBE_S3_BUCKET)");
    return 2;
  }
  const database = createDb(databaseUrl, { max: 2 });
  try {
    const { dryRun } = args;
    const result = await repairWorkspaces(
      database.db,
      createS3ObjectStore(s3),
      { ...args, prefix: s3.prefix },
      logger,
    );
    console.log(JSON.stringify({ ...result, dry_run: dryRun }));
    return dryRun && result.missing > 0 ? 1 : 0;
  } finally {
    await database.close();
  }
}

main().then(exitSoon, (err: unknown) => {
  console.error(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
  exitSoon(2);
});
