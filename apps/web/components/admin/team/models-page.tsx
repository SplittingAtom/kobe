"use client";

import {
  listTeamModels,
  modelName,
  setTeamModel,
  type TeamModel,
  type TeamModels,
} from "../../../lib/admin/api/team/models";
import { useTeamAccess } from "../console-context";
import { MutationStatus } from "../error-notice";
import { ResourceView, confirmed } from "../parts";
import { useMutation, useResource, type Mutation } from "../use-resource";
import styles from "../admin.module.css";

/**
 * Team console: the team's models (spec D6, D30; `/v1/team/models`, team.models.manage). Team
 * admins enable a subset of the install catalog and pick the default; members choose among the
 * enabled ones per conversation.
 */
export function TeamModelsPage() {
  const teamId = useTeamAccess().team.id;
  const { state, reload } = useResource(() => listTeamModels(teamId));
  const mutation = useMutation();

  return (
    <>
      <h1>Models</h1>
      <p className={styles.hint}>
        Choose which of the install&apos;s models your team may use and which one is the default.
        Conversations use the default unless someone picks another enabled model for them. Usage is
        charged to the team&apos;s budget.
      </p>
      <MutationStatus error={mutation.error} notice={mutation.notice} />
      <ResourceView state={state} label="models">
        {(data) => (
          <ModelsTable teamId={teamId} data={data} mutation={mutation} onChanged={reload} />
        )}
      </ResourceView>
    </>
  );
}

function ModelsTable({
  teamId,
  data,
  mutation,
  onChanged,
}: {
  readonly teamId: string;
  readonly data: TeamModels;
  readonly mutation: Mutation;
  readonly onChanged: () => void;
}) {
  if (data.models.length === 0) {
    return <p>The install&apos;s catalog is empty: ask an install admin to publish models.</p>;
  }
  const enabled = data.models.filter((m) => m.enabled);
  const defaultModel = data.models.find((m) => m.alias === data.default);

  async function toggle(m: TeamModel) {
    if (m.enabled) {
      const warning = m.isDefault
        ? `Disable ${modelName(m)}? It is the team's default: conversations without a chosen model can't run until you pick another default. Conversations that chose it stop too.`
        : `Disable ${modelName(m)}? Conversations that chose it stop until they pick another model.`;
      if (!confirmed(warning)) return;
    }
    const done = await mutation.run(
      () => setTeamModel(teamId, m.alias, { enabled: !m.enabled }),
      () =>
        m.enabled
          ? `Disabled ${modelName(m)} for the team.`
          : `Enabled ${modelName(m)}: team members can choose it now.`,
    );
    if (done) onChanged();
  }

  async function makeDefault(m: TeamModel) {
    const done = await mutation.run(
      () => setTeamModel(teamId, m.alias, { enabled: true, isDefault: true }),
      () => `${modelName(m)} is the team's default model.`,
    );
    if (done) onChanged();
  }

  return (
    <>
      {enabled.length === 0 ? (
        <p className={styles.banner}>
          No model is enabled: your team&apos;s agents can&apos;t answer until you enable one.
        </p>
      ) : defaultModel === undefined ? (
        <p className={styles.banner}>
          No default model: conversations that don&apos;t choose a model can&apos;t run. Pick a
          default below.
        </p>
      ) : (
        <p>
          Default: <strong>{modelName(defaultModel)}</strong> ({enabled.length} of{" "}
          {data.models.length} models enabled)
        </p>
      )}
      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <caption>Install catalog ({data.models.length})</caption>
          <thead>
            <tr>
              <th scope="col">Model</th>
              <th scope="col">Provider model</th>
              <th scope="col">Enabled</th>
              <th scope="col">Default</th>
            </tr>
          </thead>
          <tbody>
            {data.models.map((m) => (
              <tr key={m.alias}>
                <th scope="row">
                  {modelName(m)}
                  {m.label !== null && (
                    <>
                      <br />
                      <code className={styles.hint}>{m.alias}</code>
                    </>
                  )}
                </th>
                <td>
                  <code>{m.gatewayModel}</code>
                </td>
                <td>
                  <label>
                    <input
                      type="checkbox"
                      checked={m.enabled}
                      disabled={mutation.pending}
                      onChange={() => void toggle(m)}
                    />
                    <span className={styles.visuallyHidden}> {modelName(m)} enabled</span>
                  </label>
                </td>
                <td>
                  {m.isDefault ? (
                    <strong>Default</strong>
                  ) : m.enabled ? (
                    <button
                      type="button"
                      disabled={mutation.pending}
                      onClick={() => void makeDefault(m)}
                    >
                      Make default<span className={styles.visuallyHidden}> {modelName(m)}</span>
                    </button>
                  ) : (
                    <span className={styles.hint}>Enable first</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
