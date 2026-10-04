import { APPROVAL_MODES } from "@kobe/agent-file";
import type { FieldErrors, FormState } from "../../../../lib/admin/agent-builder/form-model";
import { Field } from "./field";
import { ModelField } from "./model-field";
import styles from "./agent-builder.module.css";

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
    hint: "Connector names, one per line. Pickers come with KOBE-59.",
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
  return (
    <div className={styles.fields}>
      {TEXT_FIELDS.map(({ key, label, hint, wide }) => (
        <Field key={key} label={label} hint={hint} errors={errors[key]} wide={wide}>
          {(control) => (
            <input
              {...control}
              type="text"
              value={form[key]}
              readOnly={readOnly}
              onChange={(e) => set(key, e.target.value)}
            />
          )}
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
        errors={errors.approvalMode}
      >
        {(control) => (
          <select
            {...control}
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
          </select>
        )}
      </Field>
      {LIST_FIELDS.map(({ key, label, hint }) => (
        <Field key={key} label={label} hint={hint} errors={errors[key]}>
          {(control) => (
            <textarea
              {...control}
              rows={4}
              value={form[key]}
              readOnly={readOnly}
              onChange={(e) => set(key, e.target.value)}
            />
          )}
        </Field>
      ))}
      <label className={`${styles.checkbox} ${styles.wide}`}>
        <input
          type="checkbox"
          checked={form.skillsExclusive}
          disabled={readOnly}
          onChange={(e) => set("skillsExclusive", e.target.checked)}
        />
        Use only the listed skills (none of the user&apos;s own)
      </label>
    </div>
  );
}
