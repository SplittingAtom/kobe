"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import type { ApiResult } from "../../../lib/api/client";
import {
  TEAM_SLUG_PATTERN,
  createTeam,
  listSiteTeams,
  renameTeam,
  teamRoster,
  type SiteTeam,
} from "../../../lib/admin/api/site/teams";
import { listUsers, type SiteUser } from "../../../lib/admin/api/site/users";
import { slugFromTeamName } from "../../../lib/admin/rules";
import { roleLabel } from "../../../lib/teams";
import {
  Button,
  EmptyState,
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
} from "../../ui/console";
import { MutationStatus } from "../error-notice";
import { DateTime, ResourceView } from "../parts";
import { useMutation, useResource } from "../use-resource";

interface TeamsData {
  readonly teams: readonly SiteTeam[];
  readonly users: readonly SiteUser[];
}

async function loadTeams(): Promise<ApiResult<TeamsData>> {
  const [teams, users] = await Promise.all([listSiteTeams(), listUsers()]);
  if (!teams.ok) return teams;
  if (!users.ok) return users;
  return { ok: true, status: 200, data: { teams: teams.data, users: users.data } };
}

/**
 * Teams (spec D5/D8; `/v1/site/teams`). Site admins create a team with its first team admin,
 * rename teams and read rosters. Membership changes belong to the team's own admins (KOBE-14).
 */
export function TeamsPage() {
  const { state, reload } = useResource(loadTeams);
  const mutation = useMutation();

  return (
    <>
      <PageHeader
        title="Teams"
        description="Teams are walls: each has its own members, agents and data. Site admins create teams and name the first team admin; the team's admins manage its members from then on."
      />
      <MutationStatus error={mutation.error} notice={mutation.notice} />
      <ResourceView state={state} label="teams">
        {({ teams, users }) => (
          <>
            <CreateTeam users={users} mutation={mutation} onCreated={reload} />
            {teams.length === 0 ? (
              <EmptyState title="No teams yet." className="mt-6" />
            ) : (
              <Table
                className="mt-6"
                caption={teams.length === 1 ? "1 team" : `${teams.length} teams`}
              >
                <TableHead>
                  <TableRow>
                    <TableHeader>Name</TableHeader>
                    <TableHeader>Slug</TableHeader>
                    <TableHeader>Created</TableHeader>
                    <TableHeader>
                      <span className="sr-only">Actions</span>
                    </TableHeader>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {teams.map((t) => (
                    <TeamRow key={t.id} team={t} mutation={mutation} onRenamed={reload} />
                  ))}
                </TableBody>
              </Table>
            )}
          </>
        )}
      </ResourceView>
    </>
  );
}

type Mutation = ReturnType<typeof useMutation>;

function CreateTeam({
  users,
  mutation,
  onCreated,
}: {
  readonly users: readonly SiteUser[];
  readonly mutation: Mutation;
  readonly onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [adminUserId, setAdminUserId] = useState("");
  const active = users.filter((u) => u.deactivatedAt === null);
  const effectiveSlug = slugEdited ? slug : slugFromTeamName(name);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const input = { name: name.trim(), slug: effectiveSlug, adminUserId };
    const done = await mutation.run(
      () => createTeam(input),
      (team) => `Created ${team.name}.`,
    );
    if (done) {
      setName("");
      setSlug("");
      setSlugEdited(false);
      setAdminUserId("");
      onCreated();
    }
  }

  return (
    <Section title="Create a team">
      <form onSubmit={onSubmit} aria-label="Create a team">
        <FormRow className="mt-0">
          <Field label="Name">
            <TextInput
              required
              maxLength={100}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Field label="Slug">
            <TextInput
              required
              maxLength={32}
              pattern={TEAM_SLUG_PATTERN}
              aria-describedby="team-slug-hint"
              value={effectiveSlug}
              onChange={(e) => {
                setSlugEdited(true);
                setSlug(e.target.value);
              }}
            />
          </Field>
          <Field label="First team admin">
            <Select required value={adminUserId} onChange={(e) => setAdminUserId(e.target.value)}>
              <option value="">Choose a user…</option>
              {active.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name} ({u.email})
                </option>
              ))}
            </Select>
          </Field>
          {/* The slug's pattern is checked by the browser on submit, with its own message. */}
          <Button type="submit" variant="primary" disabled={mutation.pending}>
            Create team
          </Button>
        </FormRow>
      </form>
      <p id="team-slug-hint" className="m-0 text-sm text-console-muted">
        Lowercase letters, digits and hyphens. The slug names the team&apos;s sandbox namespace
        (kobe-team-{effectiveSlug || "slug"}) and can&apos;t be changed later.
      </p>
    </Section>
  );
}

function TeamRow({
  team,
  mutation,
  onRenamed,
}: {
  readonly team: SiteTeam;
  readonly mutation: Mutation;
  readonly onRenamed: () => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(team.name);
  const [showRoster, setShowRoster] = useState(false);
  const renameButton = useRef<HTMLButtonElement>(null);
  const wasRenaming = useRef(false);

  // Focus follows the inline form: into it on open, back to Rename on close.
  useEffect(() => {
    if (wasRenaming.current && !renaming) renameButton.current?.focus();
    wasRenaming.current = renaming;
  }, [renaming]);

  function stopRenaming() {
    setName(team.name);
    setRenaming(false);
  }

  async function onRename(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const done = await mutation.run(
      () => renameTeam(team.id, name.trim()),
      (renamed) => `Renamed to ${renamed.name}.`,
    );
    if (done) {
      setRenaming(false);
      onRenamed();
    }
  }

  return (
    <>
      <TableRow>
        <TableRowHeader>
          {renaming ? (
            <form
              onSubmit={onRename}
              className="flex flex-wrap items-center gap-1.5"
              aria-label={`Rename ${team.name}`}
            >
              <label>
                <span className="sr-only">New name for {team.name}</span>
                <TextInput
                  required
                  maxLength={100}
                  className="font-normal"
                  autoFocus
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
              <Button type="submit" size="sm" variant="primary" disabled={mutation.pending}>
                Save
              </Button>
              <Button size="sm" onClick={stopRenaming}>
                Cancel
              </Button>
            </form>
          ) : (
            team.name
          )}
        </TableRowHeader>
        <TableCell>
          <code>{team.slug}</code>
        </TableCell>
        <TableCell>
          <DateTime value={team.createdAt} />
        </TableCell>
        <TableCell>
          <div className="flex flex-wrap gap-1.5">
            {!renaming && (
              <Button size="sm" ref={renameButton} onClick={() => setRenaming(true)}>
                Rename<span className="sr-only"> {team.name}</span>
              </Button>
            )}
            <Button
              size="sm"
              aria-expanded={showRoster}
              aria-controls={`roster-${team.id}`}
              onClick={() => setShowRoster((v) => !v)}
            >
              {showRoster ? "Hide members" : "Members"}
              <span className="sr-only"> of {team.name}</span>
            </Button>
          </div>
        </TableCell>
      </TableRow>
      {showRoster && (
        <TableRow id={`roster-${team.id}`}>
          <TableCell colSpan={4}>
            <Roster team={team} />
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

function Roster({ team }: { readonly team: SiteTeam }) {
  const { state } = useResource(() => teamRoster(team.id));
  return (
    <ResourceView state={state} label={`members of ${team.name}`}>
      {(members) =>
        members.length === 0 ? (
          <p className="m-0 text-console-muted">No members.</p>
        ) : (
          <ul aria-label={`Members of ${team.name}`} className="m-0 ps-5">
            {members.map((m) => (
              <li key={m.userId}>
                {m.name} ({m.email}) · {roleLabel(m.role)}
              </li>
            ))}
          </ul>
        )
      }
    </ResourceView>
  );
}
