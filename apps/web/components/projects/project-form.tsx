"use client";

import { useState, type FormEvent } from "react";
import type { MembersMode, Project, ProjectAgent, ProjectInput } from "../../lib/projects/api";
import { Button, Field, FormRow, Select, TextInput, Textarea } from "../ui/console";

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
    <form aria-label="Project settings" onSubmit={submit} className="my-4">
      <FormRow className="mt-0">
        <Field label="Name">
          <TextInput
            value={draft.name}
            maxLength={NAME_MAX}
            required
            readOnly={disabled}
            className="read-only:bg-console-panel"
            onChange={(e) => set({ name: e.target.value })}
          />
        </Field>
        <Field label="Description" className="min-w-64 flex-1">
          <TextInput
            value={draft.description}
            maxLength={DESCRIPTION_MAX}
            readOnly={disabled}
            className="read-only:bg-console-panel"
            onChange={(e) => set({ description: e.target.value })}
          />
        </Field>
      </FormRow>
      <Field label="Instructions" className="mb-4">
        <Textarea
          rows={6}
          value={draft.instructions}
          readOnly={disabled}
          className="read-only:bg-console-panel"
          aria-describedby="project-instructions-hint"
          onChange={(e) => set({ instructions: e.target.value })}
        />
        <p id="project-instructions-hint" className="m-0 text-sm text-console-muted">
          Added to the context of every conversation in this project, as plain text. {used} /{" "}
          {INSTRUCTIONS_MAX_BYTES} bytes
          {tooLong && (
            <strong role="alert" className="text-console-danger">
              {" "}
              Too long: shorten them to save.
            </strong>
          )}
        </p>
      </Field>
      <FormRow>
        <Field label="Default agent">
          <Select
            value={draft.defaultAgentId ?? ""}
            disabled={disabled}
            onChange={(e) => set({ defaultAgentId: e.target.value === "" ? null : e.target.value })}
          >
            <option value="">The team&apos;s default</option>
            {!known && (
              <option value={draft.defaultAgentId ?? ""}>
                Current agent (not available to you)
              </option>
            )}
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Members">
          <Select
            value={draft.membersMode}
            disabled={disabled}
            onChange={(e) => set({ membersMode: e.target.value as MembersMode })}
          >
            <option value="team">Everyone in the team</option>
            <option value="selected">Selected people only</option>
          </Select>
        </Field>
        {!disabled && (
          <Button
            type="submit"
            variant="primary"
            disabled={pending || tooLong || unchanged || draft.name.trim() === ""}
          >
            {submitLabel}
          </Button>
        )}
      </FormRow>
    </form>
  );
}
