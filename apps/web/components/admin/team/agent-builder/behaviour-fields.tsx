"use client";

import { AGENT_APPROVAL_MODES, DANGEROUS_APPROVAL_MODE } from "@kobe/agent-file";
import {
  splitLines,
  type FieldErrors,
  type FormState,
} from "../../../../lib/admin/agent-builder/form-model";
import { Checkbox, Field, Notice, Select, Textarea } from "../../../ui/console";
import { useResource } from "../../use-resource";
import { useBuilderSources } from "./builder-sources";
import { ConnectorTools } from "./connector-tools";
import { fieldError } from "./field-errors";
import { ModelField } from "./model-field";
import { PickList } from "./pick-list";

const MODE_LABELS = {
  "ask-on-write": "Ask on write",
  "ask-all": "Ask for every tool",
  auto: "Auto (allow-listed tools only)",
  dangerous: "Dangerous (allowed tools run without asking)",
} as const;

/** Spans both columns of the form's grid on wide screens. */
const WIDE = "md:col-span-2";

/**
 * Who may choose Dangerous (AC1): team admins and site admins; for a gallery agent, site admins
 * where the site policy allows it (KOBE-494). The server enforces it.
 */
export function useMayChooseDangerous(): boolean {
  return useBuilderSources().mayDangerous;
}

/**
 * The creator's Behaviour tab (KOBE-476 AC2): model, approval mode (Dangerous for admins only),
 * the Skills and Connectors pickers, the Allowed / Denied tool boxes, conversation starters and
 * the skills switch. Errors come from the agent-file schema, as before.
 */
export function BehaviourFields({
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
  const mayDangerous = useMayChooseDangerous();
  const dangerous = form.approvalMode === DANGEROUS_APPROVAL_MODE;
  // A stored Dangerous mode stays visible to a non-admin (so opening never changes it).
  const modes = AGENT_APPROVAL_MODES.filter(
    (m) => m !== DANGEROUS_APPROVAL_MODE || mayDangerous || dangerous,
  );
  return (
    <div className="my-4 grid grid-cols-[minmax(0,1fr)] gap-4 md:grid-cols-2">
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
          {modes.map((mode) => (
            <option key={mode} value={mode}>
              {MODE_LABELS[mode]}
            </option>
          ))}
        </Select>
      </Field>
      {dangerous && (
        <Notice tone="warn" className={`${WIDE} my-0`}>
          <p className="m-0">
            <strong>Dangerous mode:</strong> this agent runs its allowed tools without asking for
            approval. Denied tools, site and team rules, connector exposure and the sandbox still
            apply, and every call it allows is audited.
            {!mayDangerous && " Only site and team admins can save an agent in this mode."}
          </p>
        </Notice>
      )}
      <div className={WIDE}>
        <SkillsField form={form} errors={errors} readOnly={readOnly} onChange={onChange} />
      </div>
      <Checkbox
        className={WIDE}
        checked={form.skillsExclusive}
        disabled={readOnly}
        onChange={(e) => set("skillsExclusive", e.target.checked)}
        label="Use only the listed skills (none of the user's own)"
      />
      <div className={`${WIDE} flex flex-col gap-4`}>
        <ConnectorTools form={form} errors={errors} readOnly={readOnly} onChange={onChange} />
      </div>
      <Field
        label="Conversation starters"
        hint="Up to 8, one per line."
        error={fieldError(errors.starters)}
        className={WIDE}
      >
        <Textarea
          rows={4}
          value={form.starters}
          readOnly={readOnly}
          className="w-full read-only:bg-console-panel"
          onChange={(e) => set("starters", e.target.value)}
        />
      </Field>
    </div>
  );
}

/** Skills picker: the skills this member can use in the team, or any name typed in. */
function SkillsField({
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
  const sources = useBuilderSources();
  const { state } = useResource(sources.skills);
  const names =
    state.status === "ready"
      ? [...state.data.personal, ...state.data.team, ...state.data.catalog].map((s) => s.name)
      : [];
  const options = [...new Set(names)].sort().map((n) => ({ value: n, label: n }));
  return (
    <PickList
      legend="Skills"
      hint="Skills the agent loads; pick from yours and the team's, or type a skill name."
      chosen={splitLines(form.skills)}
      options={options}
      noun="skill"
      readOnly={readOnly}
      error={fieldError(errors.skills)}
      allowTyped
      onChange={(next) => onChange({ ...form, skills: next.join("\n") })}
    />
  );
}
