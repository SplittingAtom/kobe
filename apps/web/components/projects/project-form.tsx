"use client";

import { useState, type FormEvent } from "react";
import type { MembersMode, Project, ProjectAgent, ProjectInput } from "../../lib/projects/api";
import styles from "../admin/admin.module.css";

/** Mirrors `PROJECT_*` in `@kobe/protocol` (the server checks again). */
export const NAME_MAX = 100;
export const DESCRIPTION_MAX = 500;
export const INSTRUCTIONS_MAX_BYTES = 8 * 1024;

const encoder = new TextEncoder();
const bytes = (text: string): number => encoder.encode(text).length;

export const EMPTY_PROJECT: ProjectInput = {
  name: "",
  description: "",
  instructions: "",
  defaultAgentId: null,
  membersMode: "team",
};

export function inputOf(project: Project): ProjectInput {
  return {
    name: project.name,
    description: project.description,
    instructions: project.instructions,
    defaultAgentId: project.defaultAgentId,
    membersMode: project.membersMode,
  };
}

/**
 * Name, description, instructions, default agent and members mode. Everything typed or shown is
 * plain text (inputs and a textarea, never HTML). `disabled` shows the values read-only.
 */
export function ProjectForm({
  initial,
  agents,
  submitLabel,
  disabled,
  pending,
  onSubmit,
}: {
  readonly initial: ProjectInput;
  readonly agents: readonly ProjectAgent[];
  readonly submitLabel: string;
  readonly disabled: boolean;
  readonly pending: boolean;
  readonly onSubmit: (input: ProjectInput) => void;
}) {
  const [draft, setDraft] = useState(initial);
  const used = bytes(draft.instructions);
  const tooLong = used > INSTRUCTIONS_MAX_BYTES;
  const unchanged = JSON.stringify(draft) === JSON.stringify(initial);
  const set = (change: Partial<ProjectInput>) => setDraft((d) => ({ ...d, ...change }));
  const known = draft.defaultAgentId === null || agents.some((a) => a.id === draft.defaultAgentId);

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!disabled && !tooLong) onSubmit({ ...draft, name: draft.name.trim() });
  }

  return (
    <form className={styles.form} aria-label="Project settings" onSubmit={submit}>
      <label>
        Name
        <input
          value={draft.name}
          maxLength={NAME_MAX}
          required
          readOnly={disabled}
          onChange={(e) => set({ name: e.target.value })}
        />
      </label>
      <label>
        Description
        <input
          value={draft.description}
          maxLength={DESCRIPTION_MAX}
          readOnly={disabled}
          onChange={(e) => set({ description: e.target.value })}
        />
      </label>
      <label style={{ flexBasis: "100%" }}>
        Instructions
        <textarea
          rows={6}
          value={draft.instructions}
          readOnly={disabled}
          aria-describedby="project-instructions-hint"
          onChange={(e) => set({ instructions: e.target.value })}
        />
      </label>
      <p
        id="project-instructions-hint"
        className={styles.hint}
        style={{ flexBasis: "100%", margin: 0 }}
      >
        Added to the context of every conversation in this project, as plain text. {used} /{" "}
        {INSTRUCTIONS_MAX_BYTES} bytes
        {tooLong && <strong role="alert"> Too long: shorten them to save.</strong>}
      </p>
      <label>
        Default agent
        <select
          value={draft.defaultAgentId ?? ""}
          disabled={disabled}
          onChange={(e) => set({ defaultAgentId: e.target.value === "" ? null : e.target.value })}
        >
          <option value="">The team&apos;s default</option>
          {!known && (
            <option value={draft.defaultAgentId ?? ""}>Current agent (not available to you)</option>
          )}
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Members
        <select
          value={draft.membersMode}
          disabled={disabled}
          onChange={(e) => set({ membersMode: e.target.value as MembersMode })}
        >
          <option value="team">Everyone in the team</option>
          <option value="selected">Selected people only</option>
        </select>
      </label>
      {!disabled && (
        <button
          type="submit"
          disabled={pending || tooLong || unchanged || draft.name.trim() === ""}
        >
          {submitLabel}
        </button>
      )}
    </form>
  );
}
