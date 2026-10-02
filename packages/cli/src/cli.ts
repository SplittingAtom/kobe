#!/usr/bin/env node
import { runBackup } from "./backup.js";
import { parseCommand, type Command } from "./config.js";
import { runRestore } from "./restore.js";
import { s3Lister } from "./s3.js";

const log = (message: string): void => {
  process.stderr.write(`kobe: ${message}\n`);
};

async function run(cmd: Command): Promise<void> {
  const objects = cmd.s3 ? s3Lister(cmd.s3) : null;
  if (cmd.command === "backup") {
    const m = await runBackup({
      databaseUrl: cmd.databaseUrl,
      out: cmd.out,
      objects,
      pgBinDir: cmd.pgBinDir,
      log,
    });
    const rows = m.tables.reduce((sum, t) => sum + t.rows, 0);
    log(
      `backup written to ${cmd.out}: ${m.tables.length} tables, ${rows} rows` +
        (m.objectStorage ? `, ${m.objectStorage.objects} S3 objects listed` : ", no S3 manifest") +
        `; not included: ${m.excludedTables.map((t) => t.name).join(", ") || "-"}`,
    );
    log(
      "Kubernetes Secrets (auth secret, database and S3 credentials) are not in the backup; keep copies separately (docs/backup-restore.md)",
    );
    return;
  }
  const report = await runRestore({
    databaseUrl: cmd.databaseUrl,
    from: cmd.from,
    objects,
    allowMissingObjects: cmd.allowMissingObjects,
    pgBinDir: cmd.pgBinDir,
    log,
  });
  log(
    `restored ${report.tables} tables, ${report.rows} rows` +
      (report.objects
        ? `; S3 objects checked: ${report.objects.checked}, problems: ${report.objects.missing}`
        : "") +
      `. Users sign in again (sessions are not backed up). Scale the server and scheduler back up.`,
  );
}

async function main(): Promise<void> {
  let cmd: Command;
  try {
    cmd = parseCommand(process.argv.slice(2), process.env);
  } catch (err) {
    log((err as Error).message);
    process.exit(2);
  }
  await run(cmd);
}

main().catch((err: unknown) => {
  log(`error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
