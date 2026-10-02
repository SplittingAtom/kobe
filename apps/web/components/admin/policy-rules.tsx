"use client";

import { useState, type FormEvent } from "react";
import type { ApiResult } from "../../lib/api/client";
import type { NewRule, PolicyRule, RuleEffect } from "../../lib/admin/api/policy";
import { MutationStatus } from "./error-notice";
import { DateTime, ResourceView, confirmed } from "./parts";
import { useMutation, useResource } from "./use-resource";
import styles from "./admin.module.css";

const EFFECT_LABEL: Readonly<Record<RuleEffect, string>> = {
  deny: "Deny",
  ask: "Ask",
  allow: "Allow",
};

/**
 * Tool rules for one scope (install floor or team, KOBE-35). The server validates every rule (glob
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
    if (!confirmed(`Remove the rule "${EFFECT_LABEL[rule.effect]} ${rule.toolGlob}"?`)) return;
    const done = await mutation.run(
      () => remove(rule.id),
      () => `Removed: ${EFFECT_LABEL[rule.effect]} for ${rule.toolGlob}.`,
    );
    if (done) reload();
  }

  return (
    <>
      <form onSubmit={onAdd} className={styles.form} aria-label="Add a rule">
        <label>
          Effect
          <select value={effect} onChange={(e) => setEffect(e.target.value as RuleEffect)}>
            {effects.map((x) => (
              <option key={x} value={x}>
                {EFFECT_LABEL[x]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Tool pattern
          <input
            required
            maxLength={256}
            placeholder="mcp__github__*"
            aria-describedby="rule-glob-hint"
            value={toolGlob}
            onChange={(e) => setToolGlob(e.target.value)}
          />
        </label>
        <label>
          Note (optional)
          <input maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
        <label>
          Expires (optional)
          <input
            type="datetime-local"
            value={expires}
            onChange={(e) => setExpires(e.target.value)}
          />
        </label>
        <button type="submit" disabled={mutation.pending}>
          Add rule
        </button>
      </form>
      <p id="rule-glob-hint" className={styles.hint}>
        A tool name or glob: a built-in tool (<code>bash</code>, <code>write</code>) or a
        connector&apos;s tools (<code>mcp__server__tool</code>, <code>mcp__server__*</code>).
      </p>
      <MutationStatus error={mutation.error} notice={mutation.notice} />
      <ResourceView state={state} label="rules">
        {(rules) =>
          rules.length === 0 ? (
            <p>No rules yet.</p>
          ) : (
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <caption>
                  {caption} ({rules.length})
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Effect</th>
                    <th scope="col">Tool pattern</th>
                    <th scope="col">Arguments</th>
                    <th scope="col">Note</th>
                    <th scope="col">Expires</th>
                    <th scope="col">
                      <span className={styles.visuallyHidden}>Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rules.map((r) => (
                    <tr key={r.id}>
                      <td>{EFFECT_LABEL[r.effect]}</td>
                      <th scope="row">
                        <code>{r.toolGlob}</code>
                      </th>
                      <td>
                        {r.argPattern === null
                          ? "Any"
                          : Object.entries(r.argPattern).map(([pointer, glob]) => (
                              <div key={pointer}>
                                <code>{pointer}</code> matches <code>{glob}</code>
                              </div>
                            ))}
                      </td>
                      <td>{r.note ?? ""}</td>
                      <td>{r.expiresAt ? <DateTime value={r.expiresAt} /> : "Never"}</td>
                      <td>
                        <button
                          type="button"
                          disabled={mutation.pending}
                          onClick={() => void onRemove(r)}
                        >
                          Remove
                          <span className={styles.visuallyHidden}>
                            {" "}
                            rule {EFFECT_LABEL[r.effect]} {r.toolGlob}
                          </span>
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        }
      </ResourceView>
    </>
  );
}
