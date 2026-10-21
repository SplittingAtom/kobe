import { parseArgs } from "node:util";
import { createDb } from "@kobe/db";
import { logger } from "../logger.js";
import { createS3ObjectStore, loadS3Settings, repairWorkspaces } from "../workspace-sync/index.js";
import { exitSoon } from "./replica.js";

// Operator tool (KOBE-475), run inside a server pod (its env: database and object storage):
//   node dist/cli/workspace-repair.js [--dry-run] [--team-id <uuid> [--user-id <uuid>]]
// Checks every live workspace file against object storage and marks content that is missing
// "lost": each member's sandbox uploads it again at its next sync (push), verified against the
// recorded SHA-256 and size. Prints the counts as one JSON line; never paths or content.
// Exit 0 when nothing is missing (or everything missing is now marked), 1 on a dry run that found
// missing content, 2 on a usage or configuration error.
const USAGE = "usage: workspace-repair.js [--dry-run] [--team-id <uuid> [--user-id <uuid>]]";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      "dry-run": { type: "boolean" },
      "team-id": { type: "string" },
      "user-id": { type: "string" },
    },
  });
  const teamId = values["team-id"];
  const userId = values["user-id"];
  const badId = [teamId, userId].some((id) => id !== undefined && !UUID.test(id));
  if (badId || (userId !== undefined && teamId === undefined)) {
    console.error(USAGE);
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
    const dryRun = values["dry-run"] === true;
    const result = await repairWorkspaces(
      database.db,
      createS3ObjectStore(s3),
      {
        prefix: s3.prefix,
        dryRun,
        ...(teamId ? { teamId } : {}),
        ...(userId ? { userId } : {}),
      },
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
