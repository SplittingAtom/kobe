"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { getLastRestore, type RestoreRecord } from "../../../lib/admin/api/site/backup";
import { getRetentionMaximum } from "../../../lib/admin/api/site/retention";
import { consoleHref } from "../../../lib/admin/nav/registry";
import { Badge, Card, Notice, PageHeader, Section } from "../../ui/console";
import { DateTime, ResourceView } from "../parts";
import { useResource } from "../use-resource";

const SITE = consoleHref("site");
const DOCS = "docs/backup-restore.md";

/** A shell snippet; placeholders in angle brackets, never real values. */
function Commands({ label, children }: { readonly label: string; readonly children: string }) {
  return (
    <pre
      aria-label={label}
      className="m-0 my-2 box-border overflow-x-auto rounded-md border border-console-border bg-console-panel p-3 text-sm"
    >
      <code>{children}</code>
    </pre>
  );
}

function Steps({ children }: { readonly children: ReactNode }) {
  return <ol className="m-0 flex list-decimal flex-col gap-2 ps-6">{children}</ol>;
}

/**
 * Backup and restore (spec D31; KOBE-11): what the server can tell (the last restore from the
 * audit log, whether the deleting jobs are paused) and how to run `kobe backup` and `kobe restore`.
 * Backups run outside the server with a read-only role, so the page cannot show when the last
 * one ran; the full runbook is docs/backup-restore.md.
 */
export function BackupPage() {
  return (
    <>
      <PageHeader
        title="Backup and restore"
        description="Backups are taken with the kobe command-line tool, outside the running site. This page shows what the site itself knows and the steps to follow."
      />
      <StatusSection />
      <BackUpSection />
      <RestoreSection />
    </>
  );
}

function StatusSection() {
  const restore = useResource(getLastRestore);
  const retention = useResource(getRetentionMaximum);
  return (
    <Section id="backup-status-heading" title="Status">
      <Notice role="note" title="Kobe can't see your backups">
        <p>
          <code>kobe backup</code> connects to Postgres with a read-only role and writes the backup
          elsewhere, so nothing on the site records it. When a backup finishes it prints its
          manifest fingerprint and time: keep both in your runbook, outside the backup storage.
        </p>
      </Notice>
      <div className="grid gap-3 md:grid-cols-2">
        <Card title="Last restore">
          <ResourceView state={restore.state} label="the last restore">
            {(record) => <LastRestore record={record} />}
          </ResourceView>
        </Card>
        <Card title="Deleting jobs">
          <ResourceView state={retention.state} label="the retention status">
            {(status) =>
              status.paused ? (
                <>
                  <p className="m-0">
                    <Badge tone="attention">Paused</Badge>
                  </p>
                  <p className="m-0 mt-2 text-sm">
                    The retention pass, offboarding purges and workspace clean-up do nothing until{" "}
                    <code>retention.paused</code> is set back to false. See{" "}
                    <Link href={`${SITE}/retention`}>Retention maximum</Link>.
                  </p>
                </>
              ) : (
                <>
                  <p className="m-0">
                    <Badge tone="running">Running</Badge>
                  </p>
                  <p className="m-0 mt-2 text-sm text-console-muted">
                    Pause them before scaling back up after restoring an older backup (step 5
                    below).
                  </p>
                </>
              )
            }
          </ResourceView>
        </Card>
      </div>
    </Section>
  );
}

function LastRestore({ record }: { readonly record: RestoreRecord | null }) {
  if (!record) return <p className="m-0">No restore has been recorded on this site.</p>;
  return (
    <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
      <dt className="font-medium">Restored</dt>
      <dd className="m-0">
        <DateTime value={record.restoredAt} />
      </dd>
      <dt className="font-medium">Backup taken</dt>
      <dd className="m-0">
        <DateTime value={record.backupCreatedAt} />
      </dd>
      <dt className="font-medium">By</dt>
      <dd className="m-0">{record.operator ?? "—"}</dd>
      <dt className="font-medium">Loaded</dt>
      <dd className="m-0">
        {record.rows === null || record.tables === null
          ? "—"
          : `${record.rows.toLocaleString("en-US")} rows in ${record.tables} tables`}
      </dd>
      <dt className="font-medium">Audit head</dt>
      <dd className="m-0 break-all">
        {record.auditHead ? (
          <code>
            {record.auditHead.seq}:{record.auditHead.hash}
          </code>
        ) : (
          "—"
        )}
      </dd>
    </dl>
  );
}

function BackUpSection() {
  return (
    <Section
      id="backup-howto-heading"
      title="Back up"
      description={`Run from a machine that reaches Postgres and the S3 endpoint. Full details: ${DOCS}.`}
    >
      <Steps>
        <li>
          Once: generate the backup key and create a backup database role with{" "}
          <code>BYPASSRLS</code> and <code>pg_read_all_data</code>.
          <Commands label="Create the backup key">
            {"openssl rand -base64 32 > kobe-backup.key && chmod 600 kobe-backup.key"}
          </Commands>
        </li>
        <li>
          Take the backup into a new directory. It holds the encrypted, signed database dump and the
          list of S3 objects; sandbox volumes are left out (they are rebuilt).
          <Commands label="Take a backup">
            {[
              "export KOBE_BACKUP_KEY_FILE=<path to kobe-backup.key>",
              "export KOBE_BACKUP_DATABASE_URL=<postgres URL of the backup role>",
              "export KOBE_S3_ENDPOINT=<url> KOBE_S3_BUCKET=<bucket> KOBE_S3_REGION=<region>",
              "export KOBE_S3_ACCESS_KEY_ID=<id> KOBE_S3_SECRET_ACCESS_KEY=<secret>",
              "kobe backup --out <backup dir>/kobe-$(date -u +%Y%m%dT%H%M%SZ)",
            ].join("\n")}
          </Commands>
        </li>
        <li>Record the printed manifest fingerprint and time outside the backup storage.</li>
        <li>
          Keep these in your secret store, next to the backups: they are not in a backup, and a
          restore needs them. The backup key, the auth Secret (<code>&lt;release&gt;-auth</code>
          ), the envelope key Secret (<code>&lt;release&gt;-envelope-key</code>), and the S3 and
          database credentials.
        </li>
      </Steps>
    </Section>
  );
}

function RestoreSection() {
  return (
    <Section
      id="backup-restore-heading"
      title="Restore"
      description={`Into a fresh install of the same Kobe version, never over a running site. Full details: ${DOCS}.`}
    >
      <Steps>
        <li>Recreate the auth and envelope key Secrets from your secret store.</li>
        <li>
          Install the same Kobe version with those Secrets, the same S3 bucket and the same public
          URL. Don&apos;t run first-run setup.
        </li>
        <li>Scale the server and the scheduler to zero.</li>
        <li>
          Restore as the owner role, and check that the printed fingerprint and time match the ones
          you recorded.
          <Commands label="Restore a backup">
            {[
              "export KOBE_BACKUP_KEY_FILE=<path to kobe-backup.key>",
              "export KOBE_DB_MIGRATE_URL=<postgres URL of the owner role>",
              "export KOBE_TMPDIR=/dev/shm",
              "kobe restore --from <backup dir>",
            ].join("\n")}
          </Commands>
        </li>
        <li>
          If the backup is older than the bucket or the cluster, set <code>retention.paused</code>{" "}
          to true before scaling back up, and turn it off once you have reconciled the bucket and
          the sandbox volumes with the restored database.
        </li>
        <li>
          Scale back up. Everyone signs in again; passkeys and two-factor keep working. The restore
          is recorded in the <Link href={`${SITE}/audit`}>Audit log</Link>.
        </li>
      </Steps>
    </Section>
  );
}
