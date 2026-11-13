"use client";

import { useState, type FormEvent } from "react";
import type { ApiResult } from "../../../lib/api/client";
import { Button, Checkbox, ChoiceGroup } from "../../ui/console";
import { MutationStatus } from "../error-notice";
import { useMutation } from "../use-resource";

/** One switch: its label, a plain explanation, and the switches it needs (disabled while off). */
export interface SwitchSpec<K extends string> {
  readonly key: K;
  readonly label: string;
  readonly hint: string;
  readonly needs?: readonly K[];
}

/**
 * The memory switches of one level (Workspace or Site) with one Save (KOBE-155, KOBE-381). A
 * switch whose prerequisite is off is shown disabled; its own value is kept. Turning a switch off
 * never deletes anything.
 */
export function MemorySwitchesForm<K extends string, T extends Readonly<Record<K, boolean>>>({
  specs,
  switches,
  save,
  onSaved,
  notice,
  saveLabel = "Save",
  legend = "Memory",
}: {
  readonly specs: readonly SwitchSpec<K>[];
  readonly switches: T;
  readonly save: (change: Record<K, boolean>) => Promise<ApiResult<T>>;
  readonly onSaved: () => void;
  /** The message after a save, from the saved values. */
  readonly notice: (saved: T) => string;
  readonly saveLabel?: string;
  readonly legend?: string;
}) {
  const mutation = useMutation();
  const initial = () =>
    Object.fromEntries(specs.map((s) => [s.key, switches[s.key]])) as unknown as Record<K, boolean>;
  const [values, setValues] = useState<Record<K, boolean>>(initial);
  const dirty = specs.some((s) => values[s.key] !== switches[s.key]);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const done = await mutation.run(() => save(values), notice);
    if (done) onSaved();
  }

  return (
    <form onSubmit={onSubmit} aria-label={legend}>
      <ChoiceGroup legend={legend} stacked className="my-4">
        {specs.map((s, i) => (
          <Checkbox
            key={s.key}
            className={i === 0 ? undefined : "mt-2"}
            label={s.label}
            hint={s.hint}
            checked={values[s.key]}
            disabled={(s.needs ?? []).some((k) => !values[k])}
            onChange={(e) => setValues((v) => ({ ...v, [s.key]: e.target.checked }))}
          />
        ))}
      </ChoiceGroup>
      <Button type="submit" variant="primary" disabled={mutation.pending || !dirty}>
        {saveLabel}
      </Button>
      <MutationStatus error={mutation.error} notice={mutation.notice} />
    </form>
  );
}

/** The message after saving the master and Memories switches of one level. */
export function memoryNotice(
  where: string,
  saved: { memoryEnabled: boolean; projectMemoryEnabled: boolean; memoriesEnabled: boolean },
  level: "site" | "workspace",
): string {
  if (!saved.memoryEnabled)
    return level === "workspace"
      ? `Memory is off ${where}. Agents get no notes and no memories; Site Policy still applies. Nothing stored was deleted.`
      : `Memory is off ${where}. Agents get no notes, no memories and no Site Policy; nothing stored was deleted.`;
  if (!saved.memoriesEnabled)
    return `Memories are off ${where}; notes are on. Nothing stored was deleted.`;
  if (!saved.projectMemoryEnabled) return `Project notes are off ${where}. Memory settings saved.`;
  return `Memory settings saved ${where}.`;
}
