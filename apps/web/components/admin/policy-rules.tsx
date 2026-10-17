"use client";

import { useId, useState, type FormEvent } from "react";
import type { ApiResult } from "../../lib/api/client";
import type { NewRule, PolicyRule, RuleEffect } from "../../lib/admin/api/policy";
import {
  Button,
  EmptyState,
  Field,
  FormRow,
  Select,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableRowHeader,
  TextInput,
  useConfirm,
} from "../ui/console";
import { MutationStatus } from "./error-notice";
import { DateTime, ResourceView } from "./parts";
import { useMutation, useResource } from "./use-resource";

const EFFECT_LABEL: Readonly<Record<RuleEffect, string>> = {
  deny: "Deny",
  ask: "Ask",
  allow: "Allow",
};

/**
 * Tool rules for one scope (site floor or team, KOBE-35). The server validates every rule (glob
 * grammar, allow scoping, limits) and decides every tool call; this lists, adds and removes.
 * Argument patterns are shown; adding them waits for a fuller editor.
 */
export function RulesEditor({
  caption,
  effects,
  load,
  create,
  remove,
}: {
  readonly caption: string;
  readonly effects: readonly RuleEffect[];
  readonly load: () => Promise<ApiResult<readonly PolicyRule[]>>;
  readonly create: (rule: NewRule) => Promise<ApiResult<PolicyRule>>;
  readonly remove: (id: string) => Promise<ApiResult<void>>;
}) {
  const { state, reload } = useResource(load);
  const mutation = useMutation();
  const [effect, setEffect] = useState<RuleEffect>(effects[0] ?? "deny");
  const [toolGlob, setToolGlob] = useState("");
  const [note, setNote] = useState("");
  const [expires, setExpires] = useState("");
  const [confirm, confirmDialog] = useConfirm();
  const globHint = useId();

  async function onAdd(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const rule: NewRule = {
      effect,
      toolGlob: toolGlob.trim(),
      note: note.trim() === "" ? null : note.trim(),
      expiresAt: expires === "" ? null : new Date(expires).toISOString(),
    };
    const done = await mutation.run(
      () => create(rule),
      () => `Added: ${EFFECT_LABEL[rule.effect]} for ${rule.toolGlob}.`,
    );
    if (done) {
      setToolGlob("");
      setNote("");
      setExpires("");
      reload();
    }
  }

  async function onRemove(rule: PolicyRule) {
    const yes = await confirm({
      title: `Remove the rule "${EFFECT_LABEL[rule.effect]} ${rule.toolGlob}"?`,
      confirmLabel: "Remove rule",
    });
    if (!yes) return;
    const done = await mutation.run(
      () => remove(rule.id),
      () => `Removed: ${EFFECT_LABEL[rule.effect]} for ${rule.toolGlob}.`,
    );
    if (done) reload();
  }

  return (
    <>
      <form onSubmit={onAdd} aria-label="Add a rule">
        <FormRow className="mb-1">
          <Field label="Effect">
            <Select value={effect} onChange={(e) => setEffect(e.target.value as RuleEffect)}>
              {effects.map((x) => (
                <option key={x} value={x}>
                  {EFFECT_LABEL[x]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Tool pattern" required>
            <TextInput
              maxLength={256}
              placeholder="mcp__github__*"
              aria-describedby={globHint}
              value={toolGlob}
              onChange={(e) => setToolGlob(e.target.value)}
            />
          </Field>
          <Field label="Note (optional)">
            <TextInput maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
          <Field label="Expires (optional)">
            <TextInput
              type="datetime-local"
              value={expires}
              onChange={(e) => setExpires(e.target.value)}
            />
          </Field>
          <Button type="submit" variant="primary" disabled={mutation.pending}>
            Add rule
          </Button>
        </FormRow>
      </form>
      <p id={globHint} className="m-0 mb-4 text-sm text-console-muted">
        A tool name or glob: a built-in tool (<code>bash</code>, <code>write</code>) or a
        connector&apos;s tools (<code>mcp__server__tool</code>, <code>mcp__server__*</code>).
      </p>
      <MutationStatus error={mutation.error} notice={mutation.notice} />
      <ResourceView state={state} label="rules">
        {(rules) =>
          rules.length === 0 ? (
            <EmptyState title="No rules yet." />
          ) : (
            <Table caption={`${caption} (${rules.length})`}>
              <TableHead>
                <TableRow>
                  <TableHeader>Effect</TableHeader>
                  <TableHeader>Tool pattern</TableHeader>
                  <TableHeader>Arguments</TableHeader>
                  <TableHeader>Note</TableHeader>
                  <TableHeader>Expires</TableHeader>
                  <TableHeader>
                    <span className="sr-only">Actions</span>
                  </TableHeader>
                </TableRow>
              </TableHead>
              <TableBody>
                {rules.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell>{EFFECT_LABEL[r.effect]}</TableCell>
                    <TableRowHeader>
                      <code>{r.toolGlob}</code>
                    </TableRowHeader>
                    <TableCell>
                      {r.argPattern === null
                        ? "Any"
                        : Object.entries(r.argPattern).map(([pointer, glob]) => (
                            <div key={pointer}>
                              <code>{pointer}</code> matches <code>{glob}</code>
                            </div>
                          ))}
                    </TableCell>
                    <TableCell>{r.note ?? ""}</TableCell>
                    <TableCell>
                      {r.expiresAt ? <DateTime value={r.expiresAt} /> : "Never"}
                    </TableCell>
                    <TableCell>
                      <Button
                        size="sm"
                        variant="danger"
                        disabled={mutation.pending}
                        onClick={() => void onRemove(r)}
                      >
                        Remove
                        <span className="sr-only">
                          {" "}
                          rule {EFFECT_LABEL[r.effect]} {r.toolGlob}
                        </span>
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )
        }
      </ResourceView>
      {confirmDialog}
    </>
  );
}
