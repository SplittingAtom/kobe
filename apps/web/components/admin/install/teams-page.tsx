"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import type { ApiResult } from "../../../lib/api/client";
import {
  TEAM_SLUG_PATTERN,
  createTeam,
  listInstallTeams,
  renameTeam,
  teamRoster,
  type InstallTeam,
} from "../../../lib/admin/api/install/teams";
import { listUsers, type InstallUser } from "../../../lib/admin/api/install/users";
import { slugFromTeamName } from "../../../lib/admin/rules";
import { roleLabel } from "../../../lib/teams";
import { MutationStatus } from "../error-notice";
import { DateTime, ResourceView } from "../parts";
import { useMutation, useResource } from "../use-resource";
import styles from "../admin.module.css";

interface TeamsData {
  readonly teams: readonly InstallTeam[];
  readonly users: readonly InstallUser[];
}

async function loadTeams(): Promise<ApiResult<TeamsData>> {
  const [teams, users] = await Promise.all([listInstallTeams(), listUsers()]);
  if (!teams.ok) return teams;
  if (!users.ok) return users;
  return { ok: true, status: 200, data: { teams: teams.data, users: users.data } };
}

/**
 * Teams (spec D5/D8; `/v1/install/teams`). Install admins create a team with its first team admin,
 * rename teams and read rosters. Membership changes belong to the team's own admins (KOBE-14).
 */
export function TeamsPage() {
  const { state, reload } = useResource(loadTeams);
  const mutation = useMutation();

  return (
    <>
      <h1>Teams</h1>
      <p className={styles.hint}>
        Teams are walls: each has its own members, agents and data. Install admins create teams and
        name the first team admin; the team&apos;s admins manage its members from then on.
      </p>
      <MutationStatus error={mutation.error} notice={mutation.notice} />
      <ResourceView state={state} label="teams">
        {({ teams, users }) => (
          <>
            <CreateTeam users={users} mutation={mutation} onCreated={reload} />
            {teams.length === 0 ? (
              <p>No teams yet.</p>
            ) : (
              <div className={styles.tableWrap}>
                <table className={styles.table}>
                  <caption>{teams.length === 1 ? "1 team" : `${teams.length} teams`}</caption>
                  <thead>
                    <tr>
                      <th scope="col">Name</th>
                      <th scope="col">Slug</th>
                      <th scope="col">Created</th>
                      <th scope="col">
                        <span className={styles.visuallyHidden}>Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {teams.map((t) => (
                      <TeamRow key={t.id} team={t} mutation={mutation} onRenamed={reload} />
                    ))}
                  </tbody>
                </table>
              </div>
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
  readonly users: readonly InstallUser[];
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
    <>
      <h2>Create a team</h2>
      <form onSubmit={onSubmit} className={styles.form} aria-label="Create a team">
        <label>
          Name
          <input required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          Slug
          <input
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
        </label>
        <label>
          First team admin
          <select required value={adminUserId} onChange={(e) => setAdminUserId(e.target.value)}>
            <option value="">Choose a user…</option>
            {active.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name} ({u.email})
              </option>
            ))}
          </select>
        </label>
        {/* The slug's pattern is checked by the browser on submit, with its own message. */}
        <button type="submit" disabled={mutation.pending}>
          Create team
        </button>
      </form>
      <p id="team-slug-hint" className={styles.hint}>
        Lowercase letters, digits and hyphens. The slug names the team&apos;s sandbox namespace
        (kobe-team-{effectiveSlug || "slug"}) and can&apos;t be changed later.
      </p>
    </>
  );
}

function TeamRow({
  team,
  mutation,
  onRenamed,
}: {
  readonly team: InstallTeam;
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
      <tr>
        <th scope="row">
          {renaming ? (
            <form onSubmit={onRename} className={styles.actions} aria-label={`Rename ${team.name}`}>
              <label>
                <span className={styles.visuallyHidden}>New name for {team.name}</span>
                <input
                  required
                  maxLength={100}
                  autoFocus
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
              <button type="submit" disabled={mutation.pending}>
                Save
              </button>
              <button type="button" onClick={stopRenaming}>
                Cancel
              </button>
            </form>
          ) : (
            team.name
          )}
        </th>
        <td>
          <code>{team.slug}</code>
        </td>
        <td>
          <DateTime value={team.createdAt} />
        </td>
        <td>
          <div className={styles.actions}>
            {!renaming && (
              <button type="button" ref={renameButton} onClick={() => setRenaming(true)}>
                Rename<span className={styles.visuallyHidden}> {team.name}</span>
              </button>
            )}
            <button
              type="button"
              aria-expanded={showRoster}
              aria-controls={`roster-${team.id}`}
              onClick={() => setShowRoster((v) => !v)}
            >
              {showRoster ? "Hide members" : "Members"}
              <span className={styles.visuallyHidden}> of {team.name}</span>
            </button>
          </div>
        </td>
      </tr>
      {showRoster && (
        <tr id={`roster-${team.id}`}>
          <td colSpan={4}>
            <Roster team={team} />
          </td>
        </tr>
      )}
    </>
  );
}

function Roster({ team }: { readonly team: InstallTeam }) {
  const { state } = useResource(() => teamRoster(team.id));
  return (
    <ResourceView state={state} label={`members of ${team.name}`}>
      {(members) =>
        members.length === 0 ? (
          <p>No members.</p>
        ) : (
          <ul aria-label={`Members of ${team.name}`}>
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
