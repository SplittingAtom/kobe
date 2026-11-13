"use client";

import { useEffect, useRef } from "react";
import {
  SEMANTIC_MEMORY_KINDS,
  SEMANTIC_MEMORY_STATEMENT_MAX,
  SEMANTIC_MEMORY_TAGS_MAX,
  codePointLength,
} from "@kobe/protocol";
import type { ItemKind } from "../../lib/memory/items-api";
import { Field, Select, TextInput, Textarea } from "../ui/console";

export const KIND_LABELS: Readonly<Record<ItemKind, string>> = {
  preference: "Preference",
  fact: "Fact",
  convention: "Convention",
  definition: "Definition",
  decision: "Decision",
};

/** The editor's draft of one memory: the statement, its kind and tags as typed. */
export interface Draft {
  readonly statement: string;
  readonly kind: ItemKind;
  readonly tags: string;
}

/** "a, b ,c" → ["a", "b", "c"]: trimmed, lowercased, empty and repeated tags dropped. */
export function parseTags(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(",")) {
    const tag = raw.trim().toLowerCase();
    if (tag !== "" && !out.includes(tag)) out.push(tag);
  }
  return out;
}

/** What stops a save before it is sent (the server checks again). */
export function draftError(draft: Draft): string | null {
  if (draft.statement.trim() === "") return "Write the memory first.";
  const n = codePointLength(draft.statement);
  if (n > SEMANTIC_MEMORY_STATEMENT_MAX)
    return `A memory holds at most ${SEMANTIC_MEMORY_STATEMENT_MAX} characters (this one has ${n}).`;
  if (parseTags(draft.tags).length > SEMANTIC_MEMORY_TAGS_MAX)
    return `At most ${SEMANTIC_MEMORY_TAGS_MAX} tags.`;
  return null;
}

/**
 * The statement, kind and tags of a memory. `preferenceOnly` (an item in all my workspaces) fixes
 * the kind: only preferences follow a person between workspaces.
 */
export function DraftFields({
  draft,
  onChange,
  label,
  preferenceOnly = false,
  autoFocus = false,
}: {
  readonly draft: Draft;
  readonly onChange: (draft: Draft) => void;
  readonly label: string;
  readonly preferenceOnly?: boolean;
  /** Focus the statement when the fields appear (an Edit that opened them). */
  readonly autoFocus?: boolean;
}) {
  const box = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (autoFocus) box.current?.focus();
  }, [autoFocus]);
  const length = codePointLength(draft.statement);
  return (
    <div className="flex flex-col gap-3">
      <Field
        label={label}
        hint={`A short statement, not an instruction. ${length} of ${SEMANTIC_MEMORY_STATEMENT_MAX} characters.`}
      >
        <Textarea
          ref={box}
          rows={3}
          value={draft.statement}
          onChange={(e) => onChange({ ...draft, statement: e.target.value })}
          className="w-full"
        />
      </Field>
      <div className="flex flex-wrap gap-3">
        <Field label="Kind" className="w-fit">
          <Select
            value={draft.kind}
            disabled={preferenceOnly}
            onChange={(e) => onChange({ ...draft, kind: e.target.value as ItemKind })}
          >
            {SEMANTIC_MEMORY_KINDS.map((k) => (
              <option key={k} value={k}>
                {KIND_LABELS[k]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Tags" hint={`Separated by commas, at most ${SEMANTIC_MEMORY_TAGS_MAX}.`}>
          <TextInput
            value={draft.tags}
            onChange={(e) => onChange({ ...draft, tags: e.target.value })}
          />
        </Field>
      </div>
    </div>
  );
}
