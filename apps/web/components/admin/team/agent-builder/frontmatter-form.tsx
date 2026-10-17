import { APPROVAL_MODES } from "@kobe/agent-file";
import {
  replacedConnectorNames,
  type FieldErrors,
  type FormState,
} from "../../../../lib/admin/agent-builder/form-model";
import { Checkbox, Field, Notice, Select, Textarea, TextInput } from "../../../ui/console";
import { fieldError } from "./field-errors";
import { ModelField } from "./model-field";

type TextKey = "name" | "role" | "description" | "icon";
type ListKey = "skills" | "connectors" | "toolsAllow" | "toolsDeny" | "starters";

const TEXT_FIELDS: readonly { key: TextKey; label: string; hint?: string; wide?: boolean }[] = [
  { key: "name", label: "Name" },
  { key: "icon", label: "Icon", hint: "An icon name such as bar-chart, or an emoji." },
  { key: "role", label: "Role", hint: "One line on what the agent is for.", wide: true },
  { key: "description", label: "Description", wide: true },
];

const LIST_FIELDS: readonly { key: ListKey; label: string; hint: string }[] = [
  { key: "skills", label: "Skills", hint: "Skill slugs, one per line. Pickers come with KOBE-78." },
  {
    key: "connectors",
    label: "Connectors",
    hint: "Connector names, one per line, or tick every team connector below.",
  },
  { key: "toolsAllow", label: "Allowed tools", hint: "Tool globs that narrow what it may use." },
  { key: "toolsDeny", label: "Denied tools", hint: "Tool globs it must never use." },
  { key: "starters", label: "Conversation starters", hint: "Up to 8, one per line." },
];

const MODE_LABELS = {
  "ask-on-write": "Ask on write",
  "ask-all": "Ask for every tool",
  auto: "Auto (allow-listed tools only)",
} as const;

/** Spans both columns of the form's grid on wide screens. */
const WIDE = "md:col-span-2";

/** The agent file's frontmatter as form controls; errors come from the agent-file schema. */
export function FrontmatterForm({
  form,
  errors,
  readOnly,
  onChange,
}: {
  readonly form: FormState;
  readonly errors: FieldErrors;
  readonly readOnly: boolean;
  readonly onChange: (next: FormState) => void;
}) {
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    onChange({ ...form, [key]: value });
  const replaced = replacedConnectorNames(form);
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
      <ModelField
        form={form}
        errors={errors}
        readOnly={readOnly}
        onChange={(model) => set("model", model)}
      />
      <Field
        label="Approval mode"
        hint="Never looser than the team's floor."
        error={fieldError(errors.approvalMode)}
      >
        <Select
          className="w-full"
          value={form.approvalMode}
          disabled={readOnly}
          onChange={(e) => set("approvalMode", e.target.value as FormState["approvalMode"])}
        >
          <option value="">Team default</option>
          {APPROVAL_MODES.map((mode) => (
            <option key={mode} value={mode}>
              {MODE_LABELS[mode]}
            </option>
          ))}
        </Select>
      </Field>
      {LIST_FIELDS.map(({ key, label, hint }) => (
        <Field key={key} label={label} hint={hint} error={fieldError(errors[key])}>
          <Textarea
            rows={4}
            value={form[key]}
            readOnly={readOnly || (key === "connectors" && form.connectorsAll)}
            className="w-full read-only:bg-console-panel"
            onChange={(e) => set(key, e.target.value)}
          />
        </Field>
      ))}
      <Checkbox
        className={WIDE}
        checked={form.connectorsAll}
        disabled={readOnly}
        onChange={(e) => set("connectorsAll", e.target.checked)}
        label="Use every connector the team enables (each person still connects their own account)"
      />
      {replaced.length > 0 && (
        <Notice role="note" className={`${WIDE} my-0`}>
          Every team connector replaces the connector names listed above ({replaced.join(", ")});
          they are not saved.
        </Notice>
      )}
      <Checkbox
        className={WIDE}
        checked={form.skillsExclusive}
        disabled={readOnly}
        onChange={(e) => set("skillsExclusive", e.target.checked)}
        label="Use only the listed skills (none of the user's own)"
      />
    </div>
  );
}
