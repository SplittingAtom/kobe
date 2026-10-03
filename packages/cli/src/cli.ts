#!/usr/bin/env node
import { statSync } from "node:fs";
import { runBackup } from "./backup.js";
import { keyFileWarning, parseCommand, tlsWarning, type Command } from "./config.js";
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
      key: cmd.key,
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
      `manifest fingerprint ${m.fingerprint}, created ${m.createdAt}: record both outside the backup`,
    );
    log(
      "backup encrypted and signed with your backup key. The key and the Kubernetes Secrets (auth secret, database and S3 credentials) are not in the backup; keep them in your secret store (docs/backup-restore.md)",
    );
    return;
  }
  const report = await runRestore({
    databaseUrl: cmd.databaseUrl,
    from: cmd.from,
    objects,
    key: cmd.key,
    allowObjectMismatch: cmd.allowObjectMismatch,
    skipObjects: cmd.skipObjects,
    pgBinDir: cmd.pgBinDir,
    tmpDir: cmd.tmpDir,
    operator: cmd.operator,
    expectAuditHead: cmd.expectAuditHead,
    log,
  });
  log(
    `restored backup ${report.fingerprint} (created ${report.createdAt}): ` +
      `${report.tables} tables, ${report.rows} rows` +
      (report.objects
        ? `; S3 objects checked: ${report.objects.checked}, problems: ${report.objects.problems}`
        : "") +
      `. Users sign in again (sessions are not backed up). Scale the server and scheduler back up.`,
  );
  log(
    report.auditHead
      ? `audit chain verified; head ${report.auditHead.seq}:${report.auditHead.hash} (record it outside the cluster)`
      : "audit log empty",
  );
  // KOBE-17: legal holds are restored as they were when the backup was taken; holds placed since
  // are gone. The restore paused the audit IP erasure for 24 hours for that reason.
  log(
    `WARNING: legal holds are as of the backup (${report.createdAt}). Re-place every legal hold placed since then ` +
      "within 24 hours: the audit IP erasure is paused until then, and purges honor only the restored holds.",
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
  for (const warning of [
    tlsWarning(cmd.databaseUrl),
    keyFileWarning(process.env, (path) => statSync(path).mode),
  ]) {
    if (warning) log(warning);
  }
  await run(cmd);
}

main().catch((err: unknown) => {
  log(`error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
