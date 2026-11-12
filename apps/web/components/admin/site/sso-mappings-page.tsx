"use client";

import { useState, type FormEvent } from "react";
import type { ApiResult } from "../../../lib/api/client";
import {
  createSsoMapping,
  deleteSsoMapping,
  listSsoMappings,
  type SsoMapping,
  type SsoMappings,
} from "../../../lib/admin/api/site/sso-mappings";
import { listSiteTeams, type SiteTeam } from "../../../lib/admin/api/site/teams";
import { roleLabel, type TeamRole } from "../../../lib/teams";
import {
  Button,
  Field,
  FormRow,
  PageHeader,
  Section,
  Select,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableRowHeader,
  TextInput,
  eventTrigger,
  useConfirm,
} from "../../ui/console";
import { MutationStatus } from "../error-notice";
import { ResourceView } from "../parts";
import { useMutation, useResource } from "../use-resource";

/** Team roles only, most privileged first: a mapping never grants a site role (SSO6). */
export const MAPPABLE_ROLES: readonly TeamRole[] = ["team_admin", "contributor", "member"];

interface PageData extends SsoMappings {
  readonly teams: readonly SiteTeam[];
}

async function loadPage(): Promise<ApiResult<PageData>> {
  const [mappings, teams] = await Promise.all([listSsoMappings(), listSiteTeams()]);
  if (!mappings.ok) return mappings;
  if (!teams.ok) return teams;
  return { ok: true, status: 200, data: { ...mappings.data, teams: teams.data } };
}

/**
 * Access mappings of the single sign-on providers (KOBE-627, spec sso-oidc-scim §7). Each maps an
 * app role or group the identity provider sends to a team and a team role; the highest role wins
 * per team, and memberships people were invited to are never changed by a mapping.
 */
export function SsoMappingsPage() {
  const { state, reload } = useResource(loadPage);
  const mutation = useMutation();
  const [confirm, confirmDialog] = useConfirm();

  async function remove(m: SsoMapping, provider: string, trigger: HTMLElement | null) {
    const yes = await confirm(
      {
        title: `Delete the mapping ${m.claimValue} → ${m.teamName}?`,
        description: `People ${provider} manages through it lose that membership at their next sign-in, unless another mapping still grants it.`,
        confirmLabel: "Delete mapping",
      },
      trigger,
    );
    if (!yes) return;
    const done = await mutation.run(
      () => deleteSsoMapping(m.providerId, m.id),
      () => "Mapping deleted.",
    );
    if (done) reload();
  }

  return (
    <>
      <PageHeader
        title="SSO access mappings"
        description={
          <>
            Who may sign in with single sign-on, and with which access: each app role or group the
            identity provider sends gives a team role in one team. Mappings give team roles only,
            never site roles. Memberships a team admin made or took over are never changed. A change
            applies to each person at their next sign-in.
          </>
        }
      />
      <MutationStatus error={mutation.error} notice={mutation.notice} />
      <ResourceView state={state} label="access mappings">
        {(data) =>
          data.providers.length === 0 ? (
            <p className="text-sm">No single sign-on provider is configured yet.</p>
          ) : (
            <>
              {data.providers.map((p) => {
                const mappings = data.mappings.filter((m) => m.providerId === p.id);
                return (
                  <Section
                    key={p.id}
                    title={p.displayName}
                    description={`Matches the ${p.accessClaim === "roles" ? "app roles" : "groups"} claim${p.enabled ? "" : " (provider turned off)"}.`}
                  >
                    {mappings.length === 0 ? (
                      <p className="text-sm">No mappings: nobody gets access through it.</p>
                    ) : (
                      <Table caption={`Access mappings of ${p.displayName}`}>
                        <TableHead>
                          <TableRow>
                            <TableHeader>App role or group</TableHeader>
                            <TableHeader>Team</TableHeader>
                            <TableHeader>Team role</TableHeader>
                            <TableHeader>
                              <span className="sr-only">Actions</span>
                            </TableHeader>
                          </TableRow>
                        </TableHead>
                        <TableBody>
                          {mappings.map((m) => (
                            <TableRow key={m.id}>
                              <TableRowHeader>
                                <code>{m.claimValue}</code>
                              </TableRowHeader>
                              <TableCell>{m.teamName}</TableCell>
                              <TableCell>{roleLabel(m.role)}</TableCell>
                              <TableCell>
                                <Button
                                  size="sm"
                                  variant="danger"
                                  disabled={mutation.pending}
                                  onClick={(e) => void remove(m, p.displayName, eventTrigger(e))}
                                >
                                  Delete
                                  <span className="sr-only">
                                    {" "}
                                    mapping {m.claimValue} to {m.teamName}
                                  </span>
                                </Button>
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    )}
                    <AddMapping
                      providerId={p.id}
                      providerName={p.displayName}
                      teams={data.teams}
                      pending={mutation.pending}
                      onAdd={async (input) => {
                        const done = await mutation.run(
                          () => createSsoMapping(p.id, input),
                          () => `${input.claimValue} now gives ${roleLabel(input.role)}.`,
                        );
                        if (done) reload();
                        return done;
                      }}
                    />
                  </Section>
                );
              })}
            </>
          )
        }
      </ResourceView>
      {confirmDialog}
    </>
  );
}

function AddMapping({
  providerId,
  providerName,
  teams,
  pending,
  onAdd,
}: {
  readonly providerId: string;
  readonly providerName: string;
  readonly teams: readonly SiteTeam[];
  readonly pending: boolean;
  readonly onAdd: (input: {
    claimValue: string;
    teamId: string;
    role: TeamRole;
  }) => Promise<boolean>;
}) {
  const [claimValue, setClaimValue] = useState("");
  const [teamId, setTeamId] = useState("");
  const [role, setRole] = useState<TeamRole>("member");

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (await onAdd({ claimValue: claimValue.trim(), teamId, role })) {
      setClaimValue("");
      setTeamId("");
      setRole("member");
    }
  }

  return (
    <form
      className="mt-3"
      onSubmit={(e) => void submit(e)}
      aria-label={`Add a mapping to ${providerName}`}
    >
      <FormRow className="mt-0">
        <Field label="App role or group">
          <TextInput
            required
            maxLength={256}
            name={`claim-${providerId}`}
            value={claimValue}
            onChange={(e) => setClaimValue(e.target.value)}
            placeholder="kobe.research.member"
          />
        </Field>
        <Field label="Team">
          <Select required value={teamId} onChange={(e) => setTeamId(e.target.value)}>
            <option value="">Choose a team…</option>
            {teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Team role">
          <Select value={role} onChange={(e) => setRole(e.target.value as TeamRole)}>
            {MAPPABLE_ROLES.map((r) => (
              <option key={r} value={r}>
                {roleLabel(r)}
              </option>
            ))}
          </Select>
        </Field>
        <Button type="submit" variant="primary" disabled={pending}>
          Add mapping
        </Button>
      </FormRow>
    </form>
  );
}
