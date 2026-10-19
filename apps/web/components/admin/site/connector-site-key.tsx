"use client";

import { useState, type FormEvent } from "react";
import { KEY_HINT, KEY_PATTERN } from "../../../lib/admin/api/team/connector-grants";
import { removeSiteKey, setSiteKey, type Connector } from "../../../lib/admin/api/site/connectors";
import {
  Button,
  Field,
  FormRow,
  Notice,
  Section,
  TextInput,
  eventTrigger,
  useConfirm,
} from "../../ui/console";
import type { Mutation } from "../use-resource";

/**
 * A connector's site-wide API key (KOBE-303): entered once here, used for every member of every
 * team that enabled the connector, never shown again (only its last four characters). The
 * upstream server then sees one identity for everyone, which the warning says; Kobe's own audit
 * still records which member made each call.
 */
export function SiteKeyPanel({
  connector: c,
  mutation,
  onChanged,
  onClose,
}: {
  readonly connector: Connector;
  readonly mutation: Mutation;
  readonly onChanged: () => void;
  readonly onClose: () => void;
}) {
  const [key, setKey] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [confirm, confirmDialog] = useConfirm();
  const hasKey = c.siteKeyHint !== null;

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!KEY_PATTERN.test(key)) {
      setProblem(KEY_HINT);
      return;
    }
    setProblem(null);
    const done = await mutation.run(
      () => setSiteKey(c.id, key),
      () => (hasKey ? "Site-wide key replaced." : "Site-wide key saved."),
    );
    // The field is emptied whatever the outcome: the key is never kept on the page.
    setKey("");
    if (done) onChanged();
  }

  async function remove(trigger: HTMLElement | null) {
    const yes = await confirm(
      {
        title: `Remove the site-wide key of ${c.name}?`,
        description: "Members' calls to its tools fail until a new key is set.",
        confirmLabel: "Remove key",
      },
      trigger,
    );
    if (!yes) return;
    const done = await mutation.run(
      () => removeSiteKey(c.id),
      () => "Site-wide key removed.",
    );
    if (done) onChanged();
  }

  return (
    <Section
      title={`Site-wide key of ${c.name}`}
      actions={<Button onClick={onClose}>Close</Button>}
    >
      <Notice tone="warn">
        Shared attribution: every member of every team that enabled {c.name} calls it with this one
        key, so the server sees a single identity for everyone. Kobe&apos;s audit log still records
        which member made each call.
      </Notice>
      <p className="m-0 my-3 text-sm text-console-muted">
        {!hasKey
          ? "No key is set: members' calls fail."
          : c.siteKeyStale
            ? "The server URL changed since this key was set, so it is not used: enter the key again."
            : `A key ending ${c.siteKeyHint} is set.`}
      </p>
      <form onSubmit={save} aria-label={`Site-wide key for ${c.name}`}>
        <FormRow className="mb-0">
          <Field label="API key" error={problem}>
            <TextInput
              type="password"
              autoComplete="off"
              spellCheck={false}
              maxLength={2048}
              value={key}
              onChange={(e) => setKey(e.target.value)}
            />
          </Field>
          <Button type="submit" variant="primary" disabled={mutation.pending}>
            {hasKey ? "Replace key" : "Save key"}
          </Button>
          {hasKey ? (
            <Button
              variant="danger"
              disabled={mutation.pending}
              onClick={(e) => void remove(eventTrigger(e))}
            >
              Remove key
            </Button>
          ) : null}
        </FormRow>
      </form>
      {confirmDialog}
    </Section>
  );
}
