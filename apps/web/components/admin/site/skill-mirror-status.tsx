"use client";

import {
  getSkillMirrorStatus,
  retrySkillMirror,
  type SkillMirrorStatus,
} from "../../../lib/admin/api/site/skill-registry";
import {
  Button,
  Notice,
  Section,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../ui/console";
import { MutationStatus } from "../error-notice";
import { ResourceView } from "../parts";
import { useMutation, useResource } from "../use-resource";

/**
 * The catalog's git mirror status (KOBE-343, SK29): whether this server can push (the token
 * Secret, the egress proxy, the host in the site egress ceiling), how many catalog versions are
 * pushed, pending and failing, each failure's last error, and Retry now. Shown while the mirror
 * is on; its remote and branch are Registry settings above.
 */
export const MISSING_TEXT: Readonly<Record<string, string>> = {
  token:
    "The mirror has no token: set server.skillMirror.tokenSecret in the Helm values to a Secret holding one.",
  egress_proxy:
    "This server has no egress proxy configured, and the mirror pushes only through it (install with the Helm chart).",
};

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "never");

export function SkillMirrorStatusPanel() {
  const { state, reload } = useResource(getSkillMirrorStatus);
  const mutation = useMutation();

  async function retry() {
    const done = await mutation.run(
      () => retrySkillMirror(),
      (r) => `Retrying ${r.versions} version${r.versions === 1 ? "" : "s"}.`,
    );
    if (done) reload();
  }

  return (
    <Section title="Git mirror status" className="my-6">
      <ResourceView state={state} label="mirror status">
        {(s: SkillMirrorStatus) => (
          <>
            {s.missing.map((m) => (
              <Notice key={m} tone="warn">
                <p>{MISSING_TEXT[m] ?? m}</p>
              </Notice>
            ))}
            {s.url && s.hostInCeiling === false && (
              <Notice tone="warn">
                <p>
                  Add {new URL(s.url).hostname} to the site egress ceiling: pushes go through the
                  egress proxy.
                </p>
              </Notice>
            )}
            <p className="text-sm" aria-label="Mirror summary">
              {s.pushed} pushed · {s.pending} pending · {s.failed} failing · {s.withdrawn} withdrawn
              (blocklisted) · last push {when(s.lastPushedAt)} · branch {s.branch}
            </p>
            {s.failures.length > 0 && (
              <>
                <Table caption="Versions the mirror could not push">
                  <TableHead>
                    <TableRow>
                      <TableHeader>Version</TableHeader>
                      <TableHeader>Attempts</TableHeader>
                      <TableHeader>Last error</TableHeader>
                      <TableHeader>Next attempt</TableHeader>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {s.failures.map((f) => (
                      <TableRow key={f.registryVersionId}>
                        <TableCell>
                          {f.name} v{f.semver}
                        </TableCell>
                        <TableCell numeric>{f.attempts}</TableCell>
                        <TableCell>{f.lastError}</TableCell>
                        <TableCell>{f.nextAttemptAt ? when(f.nextAttemptAt) : "now"}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                <Button onClick={() => void retry()} disabled={mutation.pending}>
                  Retry now
                </Button>
              </>
            )}
            <MutationStatus error={mutation.error} notice={mutation.notice} />
          </>
        )}
      </ResourceView>
    </Section>
  );
}
