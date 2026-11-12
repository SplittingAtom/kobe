"use client";

import { useState, type FormEvent } from "react";
import {
  addTeamMembers,
  removeTeamMember,
  searchMemberCandidates,
  setTeamMemberRole,
  takeOverTeamMember,
  teamRoster,
  type MemberCandidate,
  type RosterMember,
  type SiteTeam,
} from "../../../lib/admin/api/site/teams";
import { roleLabel, type TeamRole } from "../../../lib/teams";
import {
  Button,
  Checkbox,
  ChoiceGroup,
  Field,
  FormRow,
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
import { useSiteAccess } from "../console-context";
import { MutationStatus } from "../error-notice";
import { ResourceView } from "../parts";
import { RoleCell, TEAM_ROLES, joinedVia } from "../team/members-page";
import { useMutation, useResource } from "../use-resource";

/**
 * One team's members in the Site console (KOBE-638): who is in it, their team role, how they
 * joined and their status; add existing users directly (no invitation), change roles, remove,
 * and Take over a membership an identity provider manages. The server applies the Team console's
 * rules (last team admin, managed rows) and audits each change in the team's log. Never your own
 * membership: Site admins reach team content through break-glass.
 */
export function TeamMembersPanel({ team }: { readonly team: SiteTeam }) {
  const access = useSiteAccess();
  const { state, reload } = useResource(() => teamRoster(team.id));
  const mutation = useMutation();
  const [confirm, confirmDialog] = useConfirm();
  // Bumped after every role change so a refused change resets the row's select.
  const [generation, setGeneration] = useState(0);

  async function changeRole(m: RosterMember, role: TeamRole) {
    await mutation.run(
      () => setTeamMemberRole(team.id, m.userId, role),
      () => `${m.name} is now ${roleLabel(role)} in ${team.name}.`,
    );
    setGeneration((n) => n + 1);
    reload();
  }

  async function remove(m: RosterMember, trigger: HTMLElement | null) {
    const yes = await confirm(
      {
        title: `Remove ${m.name} from ${team.name}?`,
        description:
          "They lose access at once; their schedules there pause. The team's admins see this in the team's audit log.",
        confirmLabel: `Remove ${m.name}`,
      },
      trigger,
    );
    if (!yes) return;
    const done = await mutation.run(
      () => removeTeamMember(team.id, m.userId),
      () => `${m.name} was removed from ${team.name}.`,
    );
    if (done) reload();
  }

  async function takeOver(m: RosterMember, trigger: HTMLElement | null) {
    const provider = m.managedBy?.providerName ?? "the identity provider";
    const yes = await confirm(
      {
        title: `Take over ${m.name}'s membership?`,
        description: `${provider} stops managing it: from now on only admins change or remove it, even when their access in ${provider} changes.`,
        confirmLabel: "Take over",
      },
      trigger,
    );
    if (!yes) return;
    const done = await mutation.run(
      () => takeOverTeamMember(team.id, m.userId),
      () => `${m.name}'s membership is no longer managed by ${provider}.`,
    );
    if (done) reload();
  }

  return (
    <div className="flex flex-col gap-3">
      <MutationStatus error={mutation.error} notice={mutation.notice} />
      <ResourceView state={state} label={`members of ${team.name}`}>
        {(members) => (
          <Table caption={`Members of ${team.name}`}>
            <TableHead>
              <TableRow>
                <TableHeader>Name</TableHeader>
                <TableHeader>Email</TableHeader>
                <TableHeader>Team role</TableHeader>
                <TableHeader>Joined by</TableHeader>
                <TableHeader>Status</TableHeader>
                <TableHeader>
                  <span className="sr-only">Actions</span>
                </TableHeader>
              </TableRow>
            </TableHead>
            <TableBody>
              {members.map((m) => {
                const self = m.userId === access.user.id;
                return (
                  <TableRow key={m.userId}>
                    <TableRowHeader>
                      {m.name}
                      {self && " (you)"}
                    </TableRowHeader>
                    <TableCell>{m.email}</TableCell>
                    <TableCell>
                      {m.managedBy || self ? (
                        roleLabel(m.role)
                      ) : (
                        <RoleCell
                          key={`${m.userId}:${m.role}:${generation}`}
                          idPrefix={`${team.id}-`}
                          member={m}
                          pending={mutation.pending}
                          onSave={(role) => changeRole(m, role)}
                        />
                      )}
                    </TableCell>
                    <TableCell>{joinedVia(m)}</TableCell>
                    <TableCell>{m.deactivated ? "Deactivated" : "Active"}</TableCell>
                    <TableCell>
                      {self ? null : m.managedBy ? (
                        <Button
                          size="sm"
                          disabled={mutation.pending}
                          onClick={(e) => void takeOver(m, eventTrigger(e))}
                        >
                          Take over<span className="sr-only"> membership of {m.name}</span>
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          variant="danger"
                          disabled={mutation.pending}
                          onClick={(e) => void remove(m, eventTrigger(e))}
                        >
                          Remove<span className="sr-only"> {m.name}</span>
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </ResourceView>
      <AddMembers team={team} onAdded={reload} />
      {confirmDialog}
    </div>
  );
}

/** Search existing users, pick one or several, choose a team role, Add: no invitation. */
function AddMembers({ team, onAdded }: { readonly team: SiteTeam; readonly onAdded: () => void }) {
  const mutation = useMutation();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<readonly MemberCandidate[] | null>(null);
  const [picked, setPicked] = useState<ReadonlyMap<string, MemberCandidate>>(new Map());
  const [role, setRole] = useState<TeamRole>("member");

  async function onSearch(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    await mutation.run(
      () => searchMemberCandidates(team.id, query),
      (found) => {
        setResults(found);
        return found.length === 0 ? "No active user matches." : null;
      },
    );
  }

  function toggle(c: MemberCandidate, on: boolean) {
    const next = new Map(picked);
    if (on) next.set(c.userId, c);
    else next.delete(c.userId);
    setPicked(next);
  }

  async function onAdd() {
    const names = [...picked.values()].map((c) => c.name).join(", ");
    const done = await mutation.run(
      () => addTeamMembers(team.id, [...picked.keys()], role),
      () => `Added ${names} to ${team.name} as ${roleLabel(role)}.`,
    );
    if (done) {
      setPicked(new Map());
      setResults(null);
      setQuery("");
      onAdded();
    }
  }

  return (
    <section aria-label={`Add members to ${team.name}`} className="flex flex-col gap-2">
      <h3 className="m-0 text-sm font-semibold">Add existing users</h3>
      <p className="m-0 text-sm text-console-muted">
        They join at once, without an invitation, and are told in Kobe (and by email). Deactivated
        users and you yourself can&apos;t be added.
      </p>
      <form onSubmit={onSearch} aria-label={`Search users for ${team.name}`}>
        <FormRow className="mt-0">
          <Field label="Name or email">
            <TextInput
              type="search"
              maxLength={200}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </Field>
          <Button type="submit" disabled={mutation.pending}>
            Search
          </Button>
        </FormRow>
      </form>
      <MutationStatus error={mutation.error} notice={mutation.notice} />
      {results !== null && results.length > 0 && (
        <ChoiceGroup legend="Users to add" stacked>
          {results.map((c) => (
            <Checkbox
              key={c.userId}
              label={`${c.name} (${c.email})`}
              checked={picked.has(c.userId)}
              onChange={(e) => toggle(c, e.target.checked)}
            />
          ))}
        </ChoiceGroup>
      )}
      {picked.size > 0 && (
        <FormRow className="mt-0">
          <Field label="Team role">
            <Select value={role} onChange={(e) => setRole(e.target.value as TeamRole)}>
              {TEAM_ROLES.map((r) => (
                <option key={r} value={r}>
                  {roleLabel(r)}
                </option>
              ))}
            </Select>
          </Field>
          <Button variant="primary" disabled={mutation.pending} onClick={() => void onAdd()}>
            Add {picked.size === 1 ? "1 user" : `${picked.size} users`}
          </Button>
        </FormRow>
      )}
    </section>
  );
}
