import { listTeamModels, modelName } from "../../../../lib/admin/api/team/models";
import type { FieldErrors, FormState } from "../../../../lib/admin/agent-builder/form-model";
import { Field, Select, TextInput } from "../../../ui/console";
import { useTeamAccess } from "../../console-context";
import { useResource } from "../../use-resource";
import { fieldError } from "./field-errors";

/**
 * The agent's model: one of the team's enabled aliases (`/v1/team/models`, KOBE-44), or the team
 * default. A stored value that isn't enabled stays selectable so opening an agent never changes it;
 * if the catalog can't load, the field falls back to free text (the schema still validates it).
 */
export function ModelField({
  form,
  errors,
  readOnly,
  onChange,
}: {
  readonly form: FormState;
  readonly errors: FieldErrors;
  readonly readOnly: boolean;
  readonly onChange: (model: string) => void;
}) {
  const teamId = useTeamAccess().team.id;
  const { state } = useResource(() => listTeamModels(teamId));
  const failed = state.status === "error";
  const enabled = state.status === "ready" ? state.data.models.filter((m) => m.enabled) : [];
  const unlisted = form.model !== "" && !enabled.some((m) => m.alias === form.model);
  return (
    <Field
      label="Model"
      hint={
        failed
          ? "The team's models couldn't be loaded; type an alias or model id."
          : "Models the team has enabled."
      }
      error={fieldError(errors.model)}
    >
      {failed ? (
        <TextInput
          type="text"
          className="w-full read-only:bg-console-panel"
          value={form.model}
          readOnly={readOnly}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <Select
          className="w-full"
          value={form.model}
          disabled={readOnly || state.status === "loading"}
          onChange={(e) => onChange(e.target.value)}
        >
          <option value="">None (use team default)</option>
          {unlisted && <option value={form.model}>{form.model} (not enabled)</option>}
          {enabled.map((m) => (
            <option key={m.alias} value={m.alias}>
              {modelName(m)}
            </option>
          ))}
        </Select>
      )}
    </Field>
  );
}
