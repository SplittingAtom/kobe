"use client";

import { useState, type FormEvent } from "react";
import type { ApiResult } from "../../../lib/api/client";
import { setTeamEvalCap, type TeamBudgets, type TeamEvalCap } from "../../../lib/admin/api/budgets";
import { formatTokens, formatUsd } from "../../../lib/admin/usage-format";
import { Button, Field, FormRow, Section, Select, TextInput } from "../../ui/console";

/**
 * The team eval cap (KOBE-327, SK18), beside the budgets: monthly, in dollars or tokens, or none.
 * Skill evals and their judge count toward it (and toward the budgets); other runs never do. At
 * the cap new evals are refused and running ones stop. Team admins with the budget permission
 * only (the page and `PUT /v1/team/budgets/eval-cap` both require it).
 */
export function EvalCapForm({
  teamId,
  cap,
  run,
}: {
  readonly teamId: string;
  readonly cap: NonNullable<TeamBudgets["evalCap"]>;
  readonly run: (change: () => Promise<ApiResult<unknown>>, notice: string) => Promise<void>;
}) {
  const [unit, setUnit] = useState<"usd" | "tokens">(cap.tokens !== null ? "tokens" : "usd");
  const [amount, setAmount] = useState(
    cap.usd !== null ? String(cap.usd) : cap.tokens !== null ? String(cap.tokens) : "",
  );
  const [invalid, setInvalid] = useState<string | null>(null);
  const has = cap.usd !== null || cap.tokens !== null;

  function parse(): TeamEvalCap | string {
    const n = Number(amount.trim());
    if (amount.trim() === "" || !Number.isFinite(n)) return "Give the cap as a number.";
    if (unit === "usd") {
      if (n < 0.01 || n > 1_000_000 || Math.abs(Math.round(n * 100) - n * 100) > 1e-6)
        return "A dollar cap is at least $0.01, in whole cents, and at most $1,000,000.";
      return { usd: n };
    }
    if (!Number.isInteger(n) || n < 1 || n > 1e12)
      return "A token cap is a whole number from 1 to 1,000,000,000,000.";
    return { tokens: n };
  }

  function save(e: FormEvent) {
    e.preventDefault();
    const next = parse();
    if (typeof next === "string") return setInvalid(next);
    setInvalid(null);
    void run(() => setTeamEvalCap(teamId, next), "The team eval cap was saved.");
  }

  const spent = cap.tokens !== null ? formatTokens(cap.monthTokens) : formatUsd(cap.monthUsd);
  return (
    <Section
      id="eval-cap"
      title="Team eval cap"
      description="A monthly cap on what skill evals and their judge may spend (they also count toward the budgets above). At the cap new evals are refused and running ones stop. Empty means none."
    >
      <p className="mt-0 text-sm">
        {has
          ? `Spent on evals this month: ${spent}.`
          : "No cap: evals are limited by the budgets only."}
      </p>
      {invalid && (
        <p role="alert" className="text-sm text-console-danger">
          {invalid}
        </p>
      )}
      <form onSubmit={save} aria-label="Team eval cap">
        <FormRow>
          <Field label="Cap per month">
            <TextInput
              inputMode="decimal"
              className="w-36"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </Field>
          <Field label="In">
            <Select value={unit} onChange={(e) => setUnit(e.target.value as "usd" | "tokens")}>
              <option value="usd">Dollars</option>
              <option value="tokens">Tokens</option>
            </Select>
          </Field>
          <Button type="submit" variant="primary">
            Save eval cap
          </Button>
          {has && (
            <Button
              type="button"
              variant="secondary"
              onClick={() =>
                void run(() => setTeamEvalCap(teamId, null), "The team eval cap was removed.")
              }
            >
              Remove cap
            </Button>
          )}
        </FormRow>
      </form>
    </Section>
  );
}
