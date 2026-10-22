"use client";

import type { FieldErrors, FormState } from "../../../../lib/admin/agent-builder/form-model";
import { Field, Textarea, TextInput } from "../../../ui/console";
import { fieldError } from "./field-errors";
import { IconPicker } from "./icon-picker";

type TextKey = "name" | "role" | "description";

const TEXT_FIELDS: readonly { key: TextKey; label: string; hint?: string; wide?: boolean }[] = [
  { key: "name", label: "Name" },
  { key: "role", label: "Role", hint: "One line on what the agent is for.", wide: true },
  { key: "description", label: "Description", wide: true },
];

/** Spans both columns of the form's grid on wide screens. */
const WIDE = "md:col-span-2";

/**
 * The creator's Identity tab (KOBE-476 AC2): name, icon, role, description and the system prompt
 * (Chris listed the prompt on both tabs; it lives here only). The slug field, for new agents, is
 * the builder's own and sits above these.
 */
export function IdentityFields({
  form,
  prompt,
  errors,
  readOnly,
  onChange,
  onPromptChange,
}: {
  readonly form: FormState;
  readonly prompt: string;
  readonly errors: FieldErrors;
  readonly readOnly: boolean;
  readonly onChange: (next: FormState) => void;
  readonly onPromptChange: (prompt: string) => void;
}) {
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    onChange({ ...form, [key]: value });
  return (
    <div className="my-4 grid grid-cols-[minmax(0,1fr)] gap-4 md:grid-cols-2">
      {TEXT_FIELDS.map(({ key, label, hint, wide }) => (
        <Field
          key={key}
          label={label}
          hint={hint}
          error={fieldError(errors[key])}
          className={wide ? WIDE : ""}
        >
          <TextInput
            type="text"
            value={form[key]}
            readOnly={readOnly}
            className="w-full read-only:bg-console-panel"
            onChange={(e) => set(key, e.target.value)}
          />
        </Field>
      ))}
      <IconPicker
        value={form.icon}
        readOnly={readOnly}
        error={fieldError(errors.icon)}
        onChange={(icon) => set("icon", icon)}
      />
      <Field
        label="System prompt"
        hint="What the agent is told at the start of every conversation."
        error={fieldError(errors.prompt)}
        className={WIDE}
      >
        <Textarea
          className="min-h-72 w-full resize-y font-mono read-only:bg-console-panel"
          value={prompt}
          readOnly={readOnly}
          onChange={(e) => onPromptChange(e.target.value)}
        />
      </Field>
    </div>
  );
}
