"use client";

import { TriangleAlertIcon } from "lucide-react";
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
import {
  Button,
  EmptyState,
  Field,
  FormRow,
  Notice,
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
import { useTeamAccess } from "../console-context";
import { MutationStatus } from "../error-notice";
import { ResourceView } from "../parts";
import { useMutation, useResource } from "../use-resource";

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

/** Amber from this share of a budget, red from the next (KOBE-301). */
export const BUDGET_WARN_PERCENT = 80;
export const BUDGET_FULL_PERCENT = 100;

export type BudgetLevel = "ok" | "warn" | "full";

export function budgetLevel(percent: number | null): BudgetLevel {
  if (percent === null) return "ok";
  if (percent >= BUDGET_FULL_PERCENT) return "full";
  return percent >= BUDGET_WARN_PERCENT ? "warn" : "ok";
}

/**
 * The share of a budget used, unrounded (the colour decides on the exact share, so 79.6 % stays
 * plain while the text says 80 %), or null without a budget.
 */
export const percentOf = (spent: number, limit: number | null): number | null =>
  limit === null ? null : limit > 0 ? (spent / limit) * 100 : 100;

/** The status colours (KOBE-301, app/theme.css): amber, then red and bold. */
export const BUDGET_LEVEL_CLASS: Readonly<Record<BudgetLevel, string | undefined>> = {
  ok: undefined,
  warn: "text-status-attention",
  full: "font-semibold text-status-failed",
};

/** A definition list of label and value pairs, side by side. */
const DL = "m-0 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 [&_dd]:m-0 [&_dt]:font-medium";

/**
 * One usage line: amber from 80 % of the budget and red from 100 % (status colours, KOBE-301),
 * with an icon and the percentage in the text, so colour never says it alone.
 */
function BudgetLine({ text, percent }: { readonly text: string; readonly percent: number | null }) {
  const level = budgetLevel(percent);
  return (
    <span className={BUDGET_LEVEL_CLASS[level]} data-budget-level={level}>
      {level !== "ok" && (
        <TriangleAlertIcon aria-hidden className="me-1 inline-block size-3.5 align-[-0.125rem]" />
      )}
      {text}
      {level === "full" && " · used up"}
    </span>
  );
}

/** The site budget, in percent only. */
export function usedOf(percent: number | null): string {
  return percent === null ? "No budget" : `${percent} % used`;
}

function Usage({ amounts, spent }: { readonly amounts: BudgetAmounts; readonly spent: Spend }) {
  return (
    <>
      <TableCell>
        <BudgetLine
          text={spentOf(spent.monthUsd, amounts.monthlyUsd)}
          percent={percentOf(spent.monthUsd, amounts.monthlyUsd)}
        />
        <br />
        <BudgetLine
          text={tokensOf(spent.monthTokens, amounts.monthlyTokens)}
          percent={percentOf(spent.monthTokens, amounts.monthlyTokens)}
        />
      </TableCell>
      <TableCell>
        <BudgetLine
          text={spentOf(spent.dayUsd, amounts.dailyUsd)}
          percent={percentOf(spent.dayUsd, amounts.dailyUsd)}
        />
        <br />
        <BudgetLine
          text={tokensOf(spent.dayTokens, amounts.dailyTokens)}
          percent={percentOf(spent.dayTokens, amounts.dailyTokens)}
        />
      </TableCell>
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
      <PageHeader
        title="Budgets"
        description="Budgets in dollars (at the catalog's prices: models without a price cost nothing in dollars) and in tokens (input, output and cached tokens, for every model). Months and days are calendar periods in UTC. At 80 % team admins are warned; at 100 % new model calls and runs are refused, and running ones stop after their current step."
      />
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
  const siteRpm = budgets.site.userRequestsPerMinute;
  const [confirm, confirmDialog] = useConfirm();

  async function removeBudget(m: TeamBudgets["members"][number], trigger: HTMLElement | null) {
    const yes = await confirm(
      {
        title: `Remove ${m.name ?? "this member"}'s budget?`,
        description: "The default member budget applies to them again.",
        confirmLabel: "Remove budget",
      },
      trigger,
    );
    if (yes) await run(() => removeMemberBudget(teamId, m.userId), "Budget removed.");
  }

  function saveTeam(e: FormEvent) {
    e.preventDefault();
    const amounts = parseAmounts(team);
    const r = rpm.trim() === "" ? null : Number(rpm);
    if (typeof amounts === "string") return setInvalid(amounts);
    if (r !== null && (!Number.isInteger(r) || r < 1 || r > siteRpm)) {
      return setInvalid(`The request rate is a whole number from 1 to ${siteRpm} (the site's).`);
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
        <Notice tone="error">
          <p>{invalid}</p>
        </Notice>
      )}
      <Section id="team-budget" title="Team">
        <dl className={DL}>
          <dt>This month ({budgets.period.month.slice(0, 7)}, UTC)</dt>
          <dd>
            <BudgetLine
              text={spentOf(budgets.team.spent.monthUsd, budgets.team.monthlyUsd)}
              percent={percentOf(budgets.team.spent.monthUsd, budgets.team.monthlyUsd)}
            />
            <br />
            <BudgetLine
              text={tokensOf(budgets.team.spent.monthTokens, budgets.team.monthlyTokens)}
              percent={percentOf(budgets.team.spent.monthTokens, budgets.team.monthlyTokens)}
            />
          </dd>
          <dt>Today (UTC)</dt>
          <dd>
            <BudgetLine
              text={spentOf(budgets.team.spent.dayUsd, budgets.team.dailyUsd)}
              percent={percentOf(budgets.team.spent.dayUsd, budgets.team.dailyUsd)}
            />
            <br />
            <BudgetLine
              text={tokensOf(budgets.team.spent.dayTokens, budgets.team.dailyTokens)}
              percent={percentOf(budgets.team.spent.dayTokens, budgets.team.dailyTokens)}
            />
          </dd>
          <dt>Requests per minute per member</dt>
          <dd>{budgets.effectiveRequestsPerMinute}</dd>
        </dl>
        <form onSubmit={saveTeam} aria-label="Team budget">
          <FormRow>
            <AmountFields value={team} onChange={setTeam} prefix="Team " />
            <Field label={`Requests per minute (max ${siteRpm})`}>
              <TextInput
                inputMode="numeric"
                className="w-36"
                value={rpm}
                placeholder={String(siteRpm)}
                onChange={(e) => setRpm(e.target.value)}
              />
            </Field>
            <Button type="submit" variant="primary">
              Save team budget
            </Button>
          </FormRow>
        </form>
      </Section>

      <SpendByKind budgets={budgets} />

      <Section
        id="default-budget"
        title="Default member budget"
        description="Applies to every member without a budget of their own, so one member cannot use up the whole team's budget. Empty means none."
      >
        <form onSubmit={saveDefaults} aria-label="Default member budget">
          <FormRow>
            <AmountFields value={defaults} onChange={setDefaults} prefix="Default " />
            <Button type="submit" variant="primary">
              Save default member budget
            </Button>
          </FormRow>
        </form>
      </Section>

      <Section id="member-budgets" title="Members">
        {budgets.members.length === 0 ? (
          <EmptyState title="No member has a budget of their own." />
        ) : (
          <Table caption="Member budgets">
            <TableHead>
              <TableRow>
                <TableHeader>Member</TableHeader>
                <TableHeader>This month</TableHeader>
                <TableHeader>Today</TableHeader>
                <TableHeader>
                  <span className="sr-only">Actions</span>
                </TableHeader>
              </TableRow>
            </TableHead>
            <TableBody>
              {budgets.members.map((m) => (
                <TableRow key={m.userId}>
                  <TableRowHeader>{m.name ?? m.email ?? m.userId}</TableRowHeader>
                  <Usage amounts={m} spent={m.spent} />
                  <TableCell>
                    <Button
                      size="sm"
                      variant="danger"
                      onClick={(e) => void removeBudget(m, eventTrigger(e))}
                    >
                      Remove budget of {m.name ?? m.email ?? "member"}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        <form onSubmit={saveMember} aria-label="Member budget">
          <FormRow>
            <Field label="Member">
              <Select value={who} onChange={(e) => setWho(e.target.value)}>
                <option value="">Choose…</option>
                {members.map((m) => (
                  <option key={m.userId} value={m.userId}>
                    {m.name}
                  </option>
                ))}
              </Select>
            </Field>
            <AmountFields value={member} onChange={setMember} prefix="Member " />
            <Button type="submit" variant="primary">
              Set member budget
            </Button>
          </FormRow>
        </form>
      </Section>

      <Section
        id="site-budget"
        title="Site"
        description="Set by site admins; every team's spend counts against it (shown in percent)."
      >
        <dl className={DL}>
          <dt>This month</dt>
          <dd>
            Dollars:{" "}
            <BudgetLine
              text={usedOf(budgets.site.percentUsed.monthUsd)}
              percent={budgets.site.percentUsed.monthUsd}
            />
            ; tokens:{" "}
            <BudgetLine
              text={usedOf(budgets.site.percentUsed.monthTokens)}
              percent={budgets.site.percentUsed.monthTokens}
            />
          </dd>
          <dt>Today</dt>
          <dd>
            Dollars:{" "}
            <BudgetLine
              text={usedOf(budgets.site.percentUsed.dayUsd)}
              percent={budgets.site.percentUsed.dayUsd}
            />
            ; tokens:{" "}
            <BudgetLine
              text={usedOf(budgets.site.percentUsed.dayTokens)}
              percent={budgets.site.percentUsed.dayTokens}
            />
          </dd>
        </dl>
      </Section>
      {confirmDialog}
    </>
  );
}

/** `run_usage.kind` (KOBE-234, KOBE-327): who spent. */
const KIND_LABELS: Readonly<Record<string, string>> = {
  run: "Runs",
  title: "Titles",
  followups: "Follow-ups",
  eval: "Skill evals",
  eval_judge: "Eval judge",
};

/**
 * This month's spend by kind, and the team eval cap (KOBE-327): every kind counts against the
 * budgets above; the cap counts skill evals and their judge only.
 */
function SpendByKind({ budgets }: { readonly budgets: TeamBudgets }) {
  const kinds = budgets.spentByKind ?? [];
  const cap = budgets.evalCap;
  if (kinds.length === 0 && !cap) return null;
  return (
    <Section id="spend-by-kind" title="This month by kind">
      {kinds.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Kind</TableHead>
              <TableHead>Dollars</TableHead>
              <TableHead>Tokens</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {kinds.map((k) => (
              <TableRow key={k.kind}>
                <TableRowHeader>{KIND_LABELS[k.kind] ?? k.kind}</TableRowHeader>
                <TableCell>{formatUsd(k.usd)}</TableCell>
                <TableCell>{formatTokens(k.tokens)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {cap && (
        <p className="mt-3 text-sm">
          Team eval cap:{" "}
          {cap.usd !== null
            ? spentOf(cap.monthUsd, cap.usd)
            : cap.tokens !== null
              ? tokensOf(cap.monthTokens, cap.tokens)
              : `none (${formatUsd(cap.monthUsd)} on evals this month)`}
        </p>
      )}
    </Section>
  );
}
