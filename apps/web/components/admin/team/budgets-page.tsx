"use client";

import { useState, type FormEvent } from "react";
import type { ApiResult } from "../../../lib/api/client";
import {
  getTeamBudgets,
  removeMemberBudget,
  setMemberBudget,
  setTeamBudget,
  type BudgetAmounts,
  type Spend,
  type TeamBudgets,
} from "../../../lib/admin/api/budgets";
import { listTeamMembers, type TeamMember } from "../../../lib/admin/api/team/members";
import { formatTokens, formatUsd } from "../../../lib/admin/usage-format";
import { AmountFields, parseAmounts, useAmountTexts } from "../budgets/amount-fields";
import { useTeamAccess } from "../console-context";
import { MutationStatus } from "../error-notice";
import { ResourceView, confirmed } from "../parts";
import { useMutation, useResource } from "../use-resource";
import styles from "../admin.module.css";

interface PageData {
  readonly budgets: TeamBudgets;
  readonly members: readonly TeamMember[];
}

async function load(teamId: string): Promise<ApiResult<PageData>> {
  const [budgets, members] = await Promise.all([getTeamBudgets(teamId), listTeamMembers(teamId)]);
  if (!budgets.ok) return budgets;
  if (!members.ok) return members;
  return { ok: true, status: 200, data: { budgets: budgets.data, members: members.data } };
}

const pct = (spent: number, limit: number) => (limit > 0 ? Math.round((spent / limit) * 100) : 100);

/** "$4.20 of $10.00 (42 %)" or "$4.20 (no budget)". */
export function spentOf(spent: number, limit: number | null): string {
  if (limit === null) return `${formatUsd(spent)} (no budget)`;
  return `${formatUsd(spent)} of ${formatUsd(limit)} (${pct(spent, limit)} %)`;
}

/** "12.3k of 50k tokens (25 %)" or "12.3k tokens (no budget)". */
export function tokensOf(spent: number, limit: number | null): string {
  if (limit === null) return `${formatTokens(spent)} tokens (no budget)`;
  return `${formatTokens(spent)} of ${formatTokens(limit)} tokens (${pct(spent, limit)} %)`;
}

/** The install budget, in percent only. */
export function usedOf(percent: number | null): string {
  return percent === null ? "No budget" : `${percent} % used`;
}

function Usage({ amounts, spent }: { readonly amounts: BudgetAmounts; readonly spent: Spend }) {
  return (
    <>
      <td>
        {spentOf(spent.monthUsd, amounts.monthlyUsd)}
        <br />
        {tokensOf(spent.monthTokens, amounts.monthlyTokens)}
      </td>
      <td>
        {spentOf(spent.dayUsd, amounts.dailyUsd)}
        <br />
        {tokensOf(spent.dayTokens, amounts.dailyTokens)}
      </td>
    </>
  );
}

/**
 * Team budgets (spec D30; `/v1/team/budgets`, team admins): monthly budgets with an optional daily
 * cap, in dollars at the catalog's prices and in tokens (user decision: tokens also cap models
 * without prices), for the team, as a default for every member, and for single members; and the
 * per-user request rate. At 80 % team admins (and the member, for their own) are warned; at
 * 100 % new model calls and runs are refused and running ones stop after their current step.
 */
export function TeamBudgetsPage() {
  const access = useTeamAccess();
  const teamId = access.team.id;
  const { state, reload } = useResource(() => load(teamId));
  const mutation = useMutation();

  return (
    <>
      <h1>Budgets</h1>
      <p className={styles.hint}>
        Budgets in dollars (at the catalog's prices: models without a price cost nothing in dollars)
        and in tokens (input, output and cached tokens, for every model). Months and days are
        calendar periods in UTC. At 80 % team admins are warned; at 100 % new model calls and runs
        are refused, and running ones stop after their current step.
      </p>
      <MutationStatus error={mutation.error} notice={mutation.notice} />
      <ResourceView state={state} label="budgets">
        {({ budgets, members }) => (
          <Body
            key={JSON.stringify([budgets.team, budgets.members])}
            teamId={teamId}
            budgets={budgets}
            members={members}
            run={async (change, notice) => {
              if (await mutation.run(change, () => notice)) reload();
            }}
          />
        )}
      </ResourceView>
    </>
  );
}

function Body({
  teamId,
  budgets,
  members,
  run,
}: {
  readonly teamId: string;
  readonly budgets: TeamBudgets;
  readonly members: readonly TeamMember[];
  readonly run: (change: () => Promise<ApiResult<unknown>>, notice: string) => Promise<void>;
}) {
  const [team, setTeam] = useAmountTexts(budgets.team);
  const [defaults, setDefaults] = useAmountTexts(budgets.team.memberDefault);
  const [member, setMember] = useAmountTexts();
  const [rpm, setRpm] = useState(
    budgets.team.userRequestsPerMinute === null ? "" : String(budgets.team.userRequestsPerMinute),
  );
  const [who, setWho] = useState("");
  const [invalid, setInvalid] = useState<string | null>(null);
  const installRpm = budgets.install.userRequestsPerMinute;

  function saveTeam(e: FormEvent) {
    e.preventDefault();
    const amounts = parseAmounts(team);
    const r = rpm.trim() === "" ? null : Number(rpm);
    if (typeof amounts === "string") return setInvalid(amounts);
    if (r !== null && (!Number.isInteger(r) || r < 1 || r > installRpm)) {
      return setInvalid(
        `The request rate is a whole number from 1 to ${installRpm} (the install's).`,
      );
    }
    setInvalid(null);
    void run(
      () => setTeamBudget(teamId, { ...amounts, user_requests_per_minute: r }),
      "The team budget was saved.",
    );
  }

  function saveDefaults(e: FormEvent) {
    e.preventDefault();
    const amounts = parseAmounts(defaults);
    if (typeof amounts === "string") return setInvalid(amounts);
    setInvalid(null);
    void run(
      () => setTeamBudget(teamId, { member_default: amounts }),
      "The default member budget was saved.",
    );
  }

  function saveMember(e: FormEvent) {
    e.preventDefault();
    const amounts = parseAmounts(member);
    if (typeof amounts === "string") return setInvalid(amounts);
    if (!who || Object.values(amounts).every((v) => v === null)) {
      return setInvalid("Choose a member and give at least one budget.");
    }
    setInvalid(null);
    void run(() => setMemberBudget(teamId, who, amounts), "The member's budget was saved.");
  }

  return (
    <>
      {invalid && (
        <p role="alert" className={styles.error}>
          {invalid}
        </p>
      )}
      <section aria-labelledby="team-budget">
        <h2 id="team-budget">Team</h2>
        <dl className={styles.dl}>
          <dt>This month ({budgets.period.month.slice(0, 7)}, UTC)</dt>
          <dd>
            {spentOf(budgets.team.spent.monthUsd, budgets.team.monthlyUsd)}
            <br />
            {tokensOf(budgets.team.spent.monthTokens, budgets.team.monthlyTokens)}
          </dd>
          <dt>Today (UTC)</dt>
          <dd>
            {spentOf(budgets.team.spent.dayUsd, budgets.team.dailyUsd)}
            <br />
            {tokensOf(budgets.team.spent.dayTokens, budgets.team.dailyTokens)}
          </dd>
          <dt>Requests per minute per member</dt>
          <dd>{budgets.effectiveRequestsPerMinute}</dd>
        </dl>
        <form className={styles.form} onSubmit={saveTeam} aria-label="Team budget">
          <AmountFields value={team} onChange={setTeam} prefix="Team " />
          <label>
            Requests per minute (max {installRpm})
            <input
              inputMode="numeric"
              value={rpm}
              placeholder={String(installRpm)}
              onChange={(e) => setRpm(e.target.value)}
            />
          </label>
          <button type="submit">Save team budget</button>
        </form>
      </section>

      <section aria-labelledby="default-budget">
        <h2 id="default-budget">Default member budget</h2>
        <p className={styles.hint}>
          Applies to every member without a budget of their own, so one member cannot use up the
          whole team's budget. Empty means none.
        </p>
        <form className={styles.form} onSubmit={saveDefaults} aria-label="Default member budget">
          <AmountFields value={defaults} onChange={setDefaults} prefix="Default " />
          <button type="submit">Save default member budget</button>
        </form>
      </section>

      <section aria-labelledby="member-budgets">
        <h2 id="member-budgets">Members</h2>
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <caption>Member budgets</caption>
            <thead>
              <tr>
                <th scope="col">Member</th>
                <th scope="col">This month</th>
                <th scope="col">Today</th>
                <th scope="col">
                  <span className={styles.visuallyHidden}>Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {budgets.members.map((m) => (
                <tr key={m.userId}>
                  <td>{m.name ?? m.email ?? m.userId}</td>
                  <Usage amounts={m} spent={m.spent} />
                  <td>
                    <button
                      type="button"
                      onClick={() => {
                        if (!confirmed(`Remove ${m.name ?? "this member"}'s budget?`)) return;
                        void run(() => removeMemberBudget(teamId, m.userId), "Budget removed.");
                      }}
                    >
                      Remove budget of {m.name ?? m.email ?? "member"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {budgets.members.length === 0 && <p>No member has a budget of their own.</p>}
        <form className={styles.form} onSubmit={saveMember} aria-label="Member budget">
          <label>
            Member
            <select value={who} onChange={(e) => setWho(e.target.value)}>
              <option value="">Choose…</option>
              {members.map((m) => (
                <option key={m.userId} value={m.userId}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>
          <AmountFields value={member} onChange={setMember} prefix="Member " />
          <button type="submit">Set member budget</button>
        </form>
      </section>

      <section aria-labelledby="install-budget">
        <h2 id="install-budget">Install</h2>
        <p className={styles.hint}>
          Set by install admins; every team's spend counts against it (shown in percent).
        </p>
        <dl className={styles.dl}>
          <dt>This month</dt>
          <dd>
            Dollars: {usedOf(budgets.install.percentUsed.monthUsd)}; tokens:{" "}
            {usedOf(budgets.install.percentUsed.monthTokens)}
          </dd>
          <dt>Today</dt>
          <dd>
            Dollars: {usedOf(budgets.install.percentUsed.dayUsd)}; tokens:{" "}
            {usedOf(budgets.install.percentUsed.dayTokens)}
          </dd>
        </dl>
      </section>
    </>
  );
}
