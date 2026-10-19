"use client";

import { useState, type FormEvent } from "react";
import {
  AUTH_LABELS,
  CREDENTIAL_LABELS,
  NAME_PATTERN,
  createConnector,
  listConnectors,
  removeConnector,
  updateConnector,
  type Connector,
  type ConnectorAuthKind,
  type ConnectorInput,
  type CredentialSource,
} from "../../../lib/admin/api/site/connectors";
import {
  Badge,
  Button,
  EmptyState,
  Field,
  FormRow,
  PageHeader,
  Section,
  Select,
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
import { DateTime, ResourceView } from "../parts";
import { useFocusAfterRemoval } from "../use-focus-after-removal";
import { useMutation, useResource, type Mutation } from "../use-resource";
import { SiteKeyPanel } from "./connector-site-key";
import { RefreshSkipped } from "./connector-refresh-skipped";
import { ToolReviewPanel } from "./connector-tool-review";

/** The list's heading: focus lands here when a removal empties the list. */
const HEADING = "registered-connectors";

const NAME_HINT = "Use lowercase letters and digits joined by - or _ (up to 64 characters).";
const EMPTY: ConnectorInput = {
  name: "",
  url: "",
  iconUrl: null,
  authKind: "none",
  credentialSource: "member",
};

/**
 * The site connector registry (spec D6, D27; `/v1/site/connectors`, KOBE-100): the MCP
 * servers teams may enable. Tool review (KOBE-101) and team enablement (KOBE-104) come later.
 */
export function ConnectorsPage() {
  const { state, reload } = useResource(() => listConnectors());
  const mutation = useMutation();
  const [editing, setEditing] = useState<Connector | null>(null);
  const [reviewing, setReviewing] = useState<Connector | null>(null);
  const [keyFor, setKeyFor] = useState<string | null>(null);
  // Looked up in the latest list, so the panel shows the hint the last save returned.
  const keyConnector =
    keyFor !== null && state.status === "ready"
      ? state.data.find((c) => c.id === keyFor && c.credentialSource === "site")
      : undefined;

  return (
    <>
      <PageHeader
        title="Connector registry"
        description="Register remote MCP servers (Streamable HTTP over https). Addresses that are private, link-local or cloud metadata are refused. Teams enable a connector themselves; removing one that teams already enabled keeps it disabled instead of deleting it."
      />
      <ConnectorForm
        key={editing?.id ?? "new"}
        editing={editing}
        mutation={mutation}
        onDone={() => {
          setEditing(null);
          reload();
        }}
        onCancel={() => setEditing(null)}
      />
      <MutationStatus error={mutation.error} notice={mutation.notice} />
      <Section id={HEADING} title="Registered connectors">
        <ResourceView state={state} label="connectors">
          {(connectors) => (
            <ConnectorTable
              connectors={connectors}
              mutation={mutation}
              onEdit={setEditing}
              onReview={setReviewing}
              onSiteKey={(c) => setKeyFor(c.id)}
              onChanged={reload}
            />
          )}
        </ResourceView>
      </Section>
      {reviewing ? (
        <ToolReviewPanel
          key={reviewing.id}
          connector={reviewing}
          mutation={mutation}
          onChanged={reload}
          onClose={() => setReviewing(null)}
        />
      ) : null}
      {keyConnector ? (
        <SiteKeyPanel
          key={keyConnector.id}
          connector={keyConnector}
          mutation={mutation}
          onChanged={reload}
          onClose={() => setKeyFor(null)}
        />
      ) : null}
    </>
  );
}

function ConnectorForm({
  editing,
  mutation,
  onDone,
  onCancel,
}: {
  readonly editing: Connector | null;
  readonly mutation: Mutation;
  readonly onDone: () => void;
  readonly onCancel: () => void;
}) {
  const initial: ConnectorInput = editing
    ? {
        name: editing.name,
        url: editing.url,
        iconUrl: editing.iconUrl,
        authKind: editing.authKind,
        credentialSource: editing.credentialSource,
      }
    : EMPTY;
  const [name, setName] = useState(initial.name);
  const [url, setUrl] = useState(initial.url);
  const [iconUrl, setIconUrl] = useState(initial.iconUrl ?? "");
  const [authKind, setAuthKind] = useState<ConnectorAuthKind>(initial.authKind);
  const [source, setSource] = useState<CredentialSource>(initial.credentialSource);
  const [problem, setProblem] = useState<string | null>(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const next: ConnectorInput = {
      name: name.trim(),
      url: url.trim(),
      iconUrl: iconUrl.trim() === "" ? null : iconUrl.trim(),
      authKind,
      // A site-wide key is for API-key connectors only (KOBE-303).
      credentialSource: authKind === "api_key" ? source : "member",
    };
    if (!NAME_PATTERN.test(next.name) || next.name.length > 64) {
      setProblem(NAME_HINT);
      return;
    }
    setProblem(null);
    const done = await mutation.run(
      () => (editing ? updateConnector(editing.id, changes(editing, next)) : createConnector(next)),
      () => (editing ? "Saved." : "Registered."),
    );
    if (done) onDone();
  }

  return (
    <form onSubmit={onSubmit} aria-label={editing ? "Edit connector" : "Register a connector"}>
      <FormRow>
        <Field label="Name" error={problem}>
          <TextInput
            required
            maxLength={64}
            spellCheck={false}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field label="Server URL">
          <TextInput
            required
            type="url"
            maxLength={2048}
            spellCheck={false}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
        </Field>
        <Field label="Icon URL (optional)">
          <TextInput
            type="url"
            maxLength={2048}
            spellCheck={false}
            value={iconUrl}
            onChange={(e) => setIconUrl(e.target.value)}
          />
        </Field>
        <Field label="Authentication">
          <Select
            value={authKind}
            onChange={(e) => setAuthKind(e.target.value as ConnectorAuthKind)}
          >
            {(Object.keys(AUTH_LABELS) as ConnectorAuthKind[]).map((k) => (
              <option key={k} value={k}>
                {AUTH_LABELS[k]}
              </option>
            ))}
          </Select>
        </Field>
        {authKind === "api_key" ? (
          <Field label="Whose key">
            <Select value={source} onChange={(e) => setSource(e.target.value as CredentialSource)}>
              {(Object.keys(CREDENTIAL_LABELS) as CredentialSource[]).map((k) => (
                <option key={k} value={k}>
                  {CREDENTIAL_LABELS[k]}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}
        <Button type="submit" variant="primary" disabled={mutation.pending}>
          {editing ? "Save changes" : "Register connector"}
        </Button>
        {editing ? <Button onClick={onCancel}>Cancel</Button> : null}
      </FormRow>
    </form>
  );
}

/** Only the fields that differ, so an edit never re-sends (and re-validates) the URL needlessly. */
function changes(current: Connector, next: ConnectorInput): Partial<ConnectorInput> {
  return {
    ...(next.name !== current.name ? { name: next.name } : {}),
    ...(next.url !== current.url ? { url: next.url } : {}),
    ...(next.iconUrl !== current.iconUrl ? { iconUrl: next.iconUrl } : {}),
    ...(next.authKind !== current.authKind ? { authKind: next.authKind } : {}),
    ...(next.credentialSource !== current.credentialSource
      ? { credentialSource: next.credentialSource }
      : {}),
  };
}

function ConnectorTable({
  connectors,
  mutation,
  onEdit,
  onReview,
  onSiteKey,
  onChanged,
}: {
  readonly connectors: readonly Connector[];
  readonly mutation: Mutation;
  readonly onEdit: (c: Connector) => void;
  readonly onReview: (c: Connector) => void;
  readonly onSiteKey: (c: Connector) => void;
  readonly onChanged: () => void;
}) {
  async function toggle(c: Connector) {
    const status = c.status === "active" ? "disabled" : "active";
    const done = await mutation.run(
      () => updateConnector(c.id, { status }),
      () => (status === "disabled" ? "Disabled." : "Enabled."),
    );
    if (done) onChanged();
  }

  const [confirm, confirmDialog] = useConfirm();
  const focus = useFocusAfterRemoval(
    connectors.map((c) => c.id),
    HEADING,
  );

  async function remove(c: Connector, index: number, trigger: HTMLElement | null) {
    const yes = await confirm(
      {
        title: `Remove the connector ${c.name} from the registry?`,
        confirmLabel: `Remove ${c.name}`,
      },
      trigger,
    );
    if (!yes) return;
    const done = await mutation.run(
      () => removeConnector(c.id),
      (r) => r.message,
    );
    if (done) {
      focus.removed(c.id, index);
      onChanged();
    }
  }

  if (connectors.length === 0) {
    return (
      <>
        <EmptyState title="No connectors are registered." />
        {confirmDialog}
      </>
    );
  }
  return (
    <div ref={focus.container}>
      <Table caption="Registered connectors" hideCaption>
        <TableHead>
          <TableRow>
            <TableHeader>Name</TableHeader>
            <TableHeader>Server URL</TableHeader>
            <TableHeader>Authentication</TableHeader>
            <TableHeader>Tools</TableHeader>
            <TableHeader>Status</TableHeader>
            <TableHeader>Updated</TableHeader>
            <TableHeader>
              <span className="sr-only">Actions</span>
            </TableHeader>
          </TableRow>
        </TableHead>
        <TableBody>
          {connectors.map((c, index) => (
            <TableRow key={c.id}>
              <TableRowHeader>
                <span className="inline-flex items-center gap-1.5">
                  {c.iconUrl ? (
                    <img
                      src={c.iconUrl}
                      alt=""
                      width={20}
                      height={20}
                      referrerPolicy="no-referrer"
                    />
                  ) : null}
                  {c.name}
                </span>
              </TableRowHeader>
              <TableCell>
                <code className="break-all">{c.url}</code>
              </TableCell>
              <TableCell>
                {AUTH_LABELS[c.authKind]}
                {c.credentialSource === "site" ? (
                  <span className="ms-1 inline-flex flex-wrap items-center gap-1.5">
                    <Badge
                      tone={c.siteKeyHint === null || c.siteKeyStale ? "attention" : "neutral"}
                    >
                      {c.siteKeyHint === null
                        ? "Site-wide key: not set"
                        : c.siteKeyStale
                          ? "Site-wide key: re-enter it (the server URL changed)"
                          : `Site-wide key ${c.siteKeyHint}`}
                    </Badge>
                    <Button size="sm" onClick={() => onSiteKey(c)}>
                      Site key<span className="sr-only"> of {c.name}</span>
                    </Button>
                  </span>
                ) : null}
              </TableCell>
              <TableCell>
                {c.toolCount}
                {c.driftedCount > 0 ? (
                  <span className="ms-1 inline-flex flex-wrap items-center gap-1.5">
                    <Badge tone="attention">{c.driftedCount} awaiting approval</Badge>
                    <Button size="sm" onClick={() => onReview(c)}>
                      Review<span className="sr-only"> tools of {c.name}</span>
                    </Button>
                  </span>
                ) : null}
                <RefreshSkipped connector={c} />
              </TableCell>
              <TableCell>
                <Badge tone={c.status === "active" ? "running" : "neutral"}>
                  {c.status === "active" ? "Active" : "Disabled"}
                </Badge>
              </TableCell>
              <TableCell>
                <DateTime value={c.updatedAt} />
              </TableCell>
              <TableCell>
                <div className="flex flex-wrap gap-1.5">
                  <Button size="sm" disabled={mutation.pending} onClick={() => onEdit(c)}>
                    Edit<span className="sr-only"> {c.name}</span>
                  </Button>
                  <Button
                    size="sm"
                    variant={c.status === "active" ? "danger" : "secondary"}
                    disabled={mutation.pending}
                    onClick={() => void toggle(c)}
                  >
                    {c.status === "active" ? "Disable" : "Enable"}
                    <span className="sr-only"> {c.name}</span>
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    data-remove=""
                    disabled={mutation.pending}
                    onClick={(e) => void remove(c, index, eventTrigger(e))}
                  >
                    Remove<span className="sr-only"> {c.name}</span>
                  </Button>
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {confirmDialog}
    </div>
  );
}
