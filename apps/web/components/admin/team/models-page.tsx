"use client";

import {
  listTeamModels,
  modelName,
  setTeamModel,
  type TeamModel,
  type TeamModels,
} from "../../../lib/admin/api/team/models";
import {
  Badge,
  Button,
  Checkbox,
  EmptyState,
  Notice,
  PageHeader,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableRowHeader,
  useConfirm,
} from "../../ui/console";
import { useTeamAccess } from "../console-context";
import { MutationStatus } from "../error-notice";
import { ResourceView } from "../parts";
import { useMutation, useResource, type Mutation } from "../use-resource";

/**
 * Team console: the team's models (spec D6, D30; `/v1/team/models`, team.models.manage). Team
 * admins enable a subset of the site catalog and pick the default; members choose among the
 * enabled ones per conversation.
 */
export function TeamModelsPage() {
  const teamId = useTeamAccess().team.id;
  const { state, reload } = useResource(() => listTeamModels(teamId));
  const mutation = useMutation();

  return (
    <>
      <PageHeader
        title="Models"
        description="Choose which of the site's models your team may use and which one is the default. Conversations use the default unless someone picks another enabled model for them. Usage is charged to the team's budget."
      />
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
  const [confirm, confirmDialog] = useConfirm();
  if (data.models.length === 0) {
    return <EmptyState title="The site's catalog is empty: ask a site admin to publish models." />;
  }
  const enabled = data.models.filter((m) => m.enabled);
  const defaultModel = data.models.find((m) => m.alias === data.default);

  async function toggle(m: TeamModel) {
    if (m.enabled) {
      const yes = await confirm({
        title: `Disable ${modelName(m)}?`,
        description: m.isDefault
          ? "It is the team's default: conversations without a chosen model can't run until you pick another default. Conversations that chose it stop too."
          : "Conversations that chose it stop until they pick another model.",
        confirmLabel: `Disable ${modelName(m)}`,
      });
      if (!yes) return;
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
        <Notice tone="warn">
          <p>
            No model is enabled: your team&apos;s agents can&apos;t answer until you enable one.
          </p>
        </Notice>
      ) : defaultModel === undefined ? (
        <Notice tone="warn">
          <p>
            No default model: conversations that don&apos;t choose a model can&apos;t run. Pick a
            default below.
          </p>
        </Notice>
      ) : (
        <p>
          Default: <strong>{modelName(defaultModel)}</strong> ({enabled.length} of{" "}
          {data.models.length} models enabled)
        </p>
      )}
      <Table caption={`Site catalog (${data.models.length})`}>
        <TableHead>
          <TableRow>
            <TableHeader>Model</TableHeader>
            <TableHeader>Provider model</TableHeader>
            <TableHeader>Enabled</TableHeader>
            <TableHeader>Default</TableHeader>
          </TableRow>
        </TableHead>
        <TableBody>
          {data.models.map((m) => (
            <TableRow key={m.alias}>
              <TableRowHeader>
                {modelName(m)}
                {m.label !== null && (
                  <>
                    <br />
                    <code className="text-sm font-normal text-console-muted">{m.alias}</code>
                  </>
                )}
              </TableRowHeader>
              <TableCell>
                <code>{m.gatewayModel}</code>
              </TableCell>
              <TableCell>
                <Checkbox
                  label={<span className="sr-only">{modelName(m)} enabled</span>}
                  checked={m.enabled}
                  disabled={mutation.pending}
                  onChange={() => void toggle(m)}
                />
              </TableCell>
              <TableCell>
                {m.isDefault ? (
                  <Badge tone="accent">Default</Badge>
                ) : m.enabled ? (
                  <Button size="sm" disabled={mutation.pending} onClick={() => void makeDefault(m)}>
                    Make default<span className="sr-only"> {modelName(m)}</span>
                  </Button>
                ) : (
                  <span className="text-sm text-console-muted">Enable first</span>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {confirmDialog}
    </>
  );
}
