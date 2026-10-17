"use client";

import { useState, type FormEvent } from "react";
import {
  addCeilingDomain,
  deleteCeilingDomain,
  getEgressCeiling,
  setCeilingMembership,
  setPresetMembership,
  type CeilingDomain,
  type EgressCeiling,
  type EgressPreset,
} from "../../../lib/admin/api/site/egress";
import {
  Button,
  Checkbox,
  EmptyState,
  Field,
  FormRow,
  PageHeader,
  Section,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableRowHeader,
  TextInput,
  eventTrigger,
  useConfirm,
} from "../../ui/console";
import { MutationStatus } from "../error-notice";
import { ResourceView } from "../parts";
import { SharedHostingNote } from "../shared-hosting-note";
import { useFocusAfterRemoval } from "../use-focus-after-removal";
import { useMutation, useResource, type Mutation } from "../use-resource";

/** The custom domains' heading: focus lands here when a delete empties the list. */
const CUSTOM_HEADING = "custom-domains";

export const PRESET_LABEL: Readonly<Record<EgressPreset, string>> = {
  package_registries: "Package registries",
  git_hosts: "Git hosts",
  web_search: "Web search provider",
};

/** The site egress ceiling (spec D6/D28; `/v1/site/egress-ceiling`, KOBE-38). */
export function EgressCeilingPage() {
  const { state, reload } = useResource(getEgressCeiling);
  const mutation = useMutation();
  return (
    <>
      <PageHeader
        title="Egress ceiling"
        description="Sandboxes reach the internet only through Kobe's egress proxy, over HTTPS, and only to domains their team enabled. The ceiling is what teams may enable: a new site reaches nothing, and package registries sit in the ceiling but are off for every team until a team admin enables them. Sandboxes have no DNS of their own; the proxy resolves names and never connects to internal addresses."
      />
      <AddDomainForm mutation={mutation} onAdded={reload} />
      <MutationStatus error={mutation.error} notice={mutation.notice} />
      <ResourceView state={state} label="egress ceiling">
        {(ceiling) => <CeilingTables ceiling={ceiling} mutation={mutation} onChanged={reload} />}
      </ResourceView>
    </>
  );
}

function AddDomainForm({
  mutation,
  onAdded,
}: {
  readonly mutation: Mutation;
  readonly onAdded: () => void;
}) {
  const [domain, setDomain] = useState("");
  const [note, setNote] = useState("");

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const done = await mutation.run(
      () => addCeilingDomain(domain.trim(), note.trim() === "" ? null : note.trim()),
      (added) => [`Added ${added.domain} to the ceiling.`, ...added.warnings].join(" "),
    );
    if (done) {
      setDomain("");
      setNote("");
      onAdded();
    }
  }

  return (
    <>
      <form onSubmit={onSubmit} aria-label="Add a domain">
        <FormRow className="mb-1">
          <Field label="Domain">
            <TextInput
              required
              maxLength={253}
              placeholder="api.example.com"
              aria-describedby="egress-domain-hint"
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
            />
          </Field>
          <Field label="Note (optional)">
            <TextInput maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
          <Button type="submit" variant="primary" disabled={mutation.pending}>
            Add domain
          </Button>
        </FormRow>
      </form>
      <p id="egress-domain-hint" className="m-0 text-sm text-console-muted">
        A host name such as <code>api.example.com</code>, or <code>*.example.com</code> for every
        subdomain (not <code>example.com</code> itself). No IP addresses, schemes or paths.
      </p>
    </>
  );
}

function CeilingTables({
  ceiling,
  mutation,
  onChanged,
}: {
  readonly ceiling: EgressCeiling;
  readonly mutation: Mutation;
  readonly onChanged: () => void;
}) {
  const custom = ceiling.domains.filter((d) => d.preset === null);
  const presets = ceiling.presets.filter((p) => ceiling.domains.some((d) => d.preset === p));
  const [confirm, confirmDialog] = useConfirm();
  const focus = useFocusAfterRemoval(
    custom.map((d) => d.domain),
    CUSTOM_HEADING,
  );

  async function toggle(d: CeilingDomain) {
    const done = await mutation.run(
      () => setCeilingMembership(d.domain, !d.inCeiling),
      (saved) =>
        saved.inCeiling
          ? `${saved.domain} is in the ceiling: teams may enable it.`
          : `${saved.domain} left the ceiling: no team's sandboxes reach it now.`,
    );
    if (done) onChanged();
  }

  async function togglePreset(preset: EgressPreset, inCeiling: boolean) {
    const done = await mutation.run(
      () => setPresetMembership(preset, inCeiling),
      () =>
        `${PRESET_LABEL[preset]}: ${inCeiling ? "all in the ceiling" : "all out of the ceiling"}.`,
    );
    if (done) onChanged();
  }

  async function remove(d: CeilingDomain, index: number, trigger: HTMLElement | null) {
    const yes = await confirm(
      {
        title: `Delete ${d.domain}?`,
        description: "Every team that enabled it loses it.",
        confirmLabel: `Delete ${d.domain}`,
      },
      trigger,
    );
    if (!yes) return;
    const done = await mutation.run(
      () => deleteCeilingDomain(d.domain),
      () => `Deleted ${d.domain}.`,
    );
    if (done) {
      focus.removed(d.domain, index);
      onChanged();
    }
  }

  return (
    <>
      {presets.map((preset) => {
        const rows = ceiling.domains.filter((d) => d.preset === preset);
        return (
          <Section
            key={preset}
            title={PRESET_LABEL[preset]}
            actions={
              <>
                <Button
                  size="sm"
                  disabled={mutation.pending || rows.every((r) => r.inCeiling)}
                  onClick={() => void togglePreset(preset, true)}
                >
                  Add all {PRESET_LABEL[preset].toLowerCase()}
                </Button>
                <Button
                  size="sm"
                  disabled={mutation.pending || rows.every((r) => !r.inCeiling)}
                  onClick={() => void togglePreset(preset, false)}
                >
                  Remove all {PRESET_LABEL[preset].toLowerCase()}
                </Button>
              </>
            }
          >
            <DomainTable
              caption={PRESET_LABEL[preset]}
              rows={rows}
              pending={mutation.pending}
              onToggle={toggle}
            />
          </Section>
        );
      })}
      <Section id={CUSTOM_HEADING} title="Custom domains">
        {custom.length === 0 ? (
          <EmptyState title="No custom domains yet." />
        ) : (
          <div ref={focus.container}>
            <DomainTable
              caption="Custom domains"
              rows={custom}
              pending={mutation.pending}
              onToggle={toggle}
              onDelete={remove}
            />
          </div>
        )}
      </Section>
      {confirmDialog}
    </>
  );
}

function DomainTable({
  caption,
  rows,
  pending,
  onToggle,
  onDelete,
}: {
  readonly caption: string;
  readonly rows: readonly CeilingDomain[];
  readonly pending: boolean;
  readonly onToggle: (d: CeilingDomain) => Promise<void>;
  readonly onDelete?: (
    d: CeilingDomain,
    index: number,
    trigger: HTMLElement | null,
  ) => Promise<void>;
}) {
  return (
    <Table caption={caption} hideCaption>
      <TableHead>
        <TableRow>
          <TableHeader>Domain</TableHeader>
          <TableHeader>In ceiling</TableHeader>
          <TableHeader>Note</TableHeader>
          {onDelete ? (
            <TableHeader>
              <span className="sr-only">Actions</span>
            </TableHeader>
          ) : null}
        </TableRow>
      </TableHead>
      <TableBody>
        {rows.map((d, index) => (
          <TableRow key={d.domain}>
            <TableRowHeader>
              <code>{d.domain}</code>
              {d.sharedHosting ? <SharedHostingNote /> : null}
            </TableRowHeader>
            <TableCell>
              <Checkbox
                label={<span className="sr-only">{d.domain} in the ceiling</span>}
                checked={d.inCeiling}
                disabled={pending}
                onChange={() => void onToggle(d)}
              />
            </TableCell>
            <TableCell>{d.note ?? ""}</TableCell>
            {onDelete ? (
              <TableCell>
                <Button
                  size="sm"
                  variant="danger"
                  data-remove=""
                  disabled={pending}
                  onClick={(e) => void onDelete(d, index, eventTrigger(e))}
                >
                  Delete<span className="sr-only"> {d.domain}</span>
                </Button>
              </TableCell>
            ) : null}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
