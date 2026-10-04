"use client";

import { useState, type FormEvent } from "react";
import type { ApiResult } from "../../../lib/api/client";
import {
  getTeamBudgets,
  parseAmount,
  removeMemberBudget,
  setMemberBudget,
  setTeamBudget,
  type BudgetAmounts,
  type Spend,
  type TeamBudgets,
} from "../../../lib/admin/api/budgets";
import { listTeamMembers, type TeamMember } from "../../../lib/admin/api/team/members";
import { formatUsd } from "../../../lib/admin/usage-format";
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

const text = (v: number | null) => (v === null ? "" : String(v));

/** "$4.20 of $10.00 (42 %)" or "$4.20 (no budget)". */
export function spentOf(spent: number, limit: number | null): string {
  if (limit === null) return `${formatUsd(spent)} (no budget)`;
  const pct = limit > 0 ? Math.round((spent / limit) * 100) : 100;
  return `${formatUsd(spent)} of ${formatUsd(limit)} (${pct} %)`;
}

function SpendCells({
  amounts,
  spent,
}: {
  readonly amounts: BudgetAmounts;
  readonly spent: Spend;
}) {
  return (
    <>
      <td>{spentOf(spent.monthUsd, amounts.monthlyUsd)}</td>
      <td>{spentOf(spent.dayUsd, amounts.dailyUsd)}</td>
    </>
  );
}

/**
 * Team budgets (spec D30; `/v1/team/budgets`, team admins): a monthly dollar budget with an
 * optional daily cap for the team and for single members, and the per-user request rate. At 80 %
 * team admins (and the member, for their own) are warned; at 100 % new model calls and runs are
 * refused and running ones stop after their current step.
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
        Dollar budgets at the catalog's prices (models without a price cost nothing here). Months
        and days are in UTC. At 80 % team admins are warned; at 100 % new model calls and runs are
        refused, and running ones stop after their current step.
      </p>
      <MutationStatus error={mutation.error} notice={mutation.notice} />
      <ResourceView state={state} label="budgets">
        {({ budgets, members }) => (
          <Body
            key={JSON.stringify([
              budgets.team,
              budgets.members.map((m) => [m.userId, m.monthlyUsd, m.dailyUsd]),
            ])}
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
  const [monthly, setMonthly] = useState(text(budgets.team.monthlyUsd));
  const [daily, setDaily] = useState(text(budgets.team.dailyUsd));
  const [rpm, setRpm] = useState(text(budgets.team.userRequestsPerMinute));
  const [who, setWho] = useState("");
  const [memberMonthly, setMemberMonthly] = useState("");
  const [memberDaily, setMemberDaily] = useState("");
  const [invalid, setInvalid] = useState<string | null>(null);
  const installRpm = budgets.install.userRequestsPerMinute;

  function saveTeam(e: FormEvent) {
    e.preventDefault();
    const m = parseAmount(monthly);
    const d = parseAmount(daily);
    const r = rpm.trim() === "" ? null : Number(rpm);
    if (m === undefined || d === undefined) {
      return setInvalid("Budgets are dollar amounts with at most two decimals, or empty.");
    }
    if (r !== null && (!Number.isInteger(r) || r < 1 || r > installRpm)) {
      return setInvalid(
        `The request rate is a whole number from 1 to ${installRpm} (the install's).`,
      );
    }
    setInvalid(null);
    void run(
      () => setTeamBudget(teamId, { monthly_usd: m, daily_usd: d, user_requests_per_minute: r }),
      "The team budget was saved.",
    );
  }

  function saveMember(e: FormEvent) {
    e.preventDefault();
    const m = parseAmount(memberMonthly);
    const d = parseAmount(memberDaily);
    if (!who || m === undefined || d === undefined || (m === null && d === null)) {
      return setInvalid("Choose a member and give a monthly or daily budget.");
    }
    setInvalid(null);
    void run(
      () => setMemberBudget(teamId, who, { monthly_usd: m, daily_usd: d }),
      "The member's budget was saved.",
    );
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
          <dt>This month ({budgets.period.month.slice(0, 7)})</dt>
          <dd>{spentOf(budgets.team.spent.monthUsd, budgets.team.monthlyUsd)}</dd>
          <dt>Today</dt>
          <dd>{spentOf(budgets.team.spent.dayUsd, budgets.team.dailyUsd)}</dd>
          <dt>Requests per minute per member</dt>
          <dd>{budgets.effectiveRequestsPerMinute}</dd>
        </dl>
        <form className={styles.form} onSubmit={saveTeam}>
          <label>
            Monthly budget ($)
            <input
              inputMode="decimal"
              value={monthly}
              onChange={(e) => setMonthly(e.target.value)}
            />
          </label>
          <label>
            Daily cap ($)
            <input inputMode="decimal" value={daily} onChange={(e) => setDaily(e.target.value)} />
          </label>
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
                  <SpendCells amounts={m} spent={m.spent} />
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
        <form className={styles.form} onSubmit={saveMember}>
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
          <label>
            Monthly ($)
            <input
              inputMode="decimal"
              value={memberMonthly}
              onChange={(e) => setMemberMonthly(e.target.value)}
            />
          </label>
          <label>
            Daily ($)
            <input
              inputMode="decimal"
              value={memberDaily}
              onChange={(e) => setMemberDaily(e.target.value)}
            />
          </label>
          <button type="submit">Set member budget</button>
        </form>
      </section>

      <section aria-labelledby="install-budget">
        <h2 id="install-budget">Install</h2>
        <p className={styles.hint}>Set by install admins; every team's spend counts against it.</p>
        <dl className={styles.dl}>
          <dt>This month</dt>
          <dd>{spentOf(budgets.install.spent.monthUsd, budgets.install.monthlyUsd)}</dd>
          <dt>Today</dt>
          <dd>{spentOf(budgets.install.spent.dayUsd, budgets.install.dailyUsd)}</dd>
        </dl>
      </section>
    </>
  );
}
