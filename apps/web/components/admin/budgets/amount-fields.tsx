"use client";

import { useState } from "react";
import {
  parseAmount,
  parseTokens,
  type BudgetAmounts,
  type BudgetAmountsInput,
} from "../../../lib/admin/api/budgets";

/** The four budget inputs as typed text. */
export interface AmountTexts {
  readonly monthlyUsd: string;
  readonly dailyUsd: string;
  readonly monthlyTokens: string;
  readonly dailyTokens: string;
}

const text = (v: number | null | undefined) => (v === null || v === undefined ? "" : String(v));

export function amountTexts(a?: BudgetAmounts): AmountTexts {
  return {
    monthlyUsd: text(a?.monthlyUsd),
    dailyUsd: text(a?.dailyUsd),
    monthlyTokens: text(a?.monthlyTokens),
    dailyTokens: text(a?.dailyTokens),
  };
}

/** The request body, or a message saying what is wrong. */
export function parseAmounts(t: AmountTexts): BudgetAmountsInput | string {
  const monthlyUsd = parseAmount(t.monthlyUsd);
  const dailyUsd = parseAmount(t.dailyUsd);
  const monthlyTokens = parseTokens(t.monthlyTokens);
  const dailyTokens = parseTokens(t.dailyTokens);
  if (monthlyUsd === undefined || dailyUsd === undefined) {
    return "Dollar budgets are amounts with at most two decimals, or empty.";
  }
  if (monthlyTokens === undefined || dailyTokens === undefined) {
    return "Token budgets are whole numbers of tokens, or empty.";
  }
  return {
    monthly_usd: monthlyUsd,
    daily_usd: dailyUsd,
    monthly_tokens: monthlyTokens,
    daily_tokens: dailyTokens,
  };
}

export function useAmountTexts(initial?: BudgetAmounts) {
  return useState<AmountTexts>(() => amountTexts(initial));
}

/**
 * Monthly and daily budgets in dollars and in tokens (KOBE-42). Tokens count input, output, cache
 * reads and cache writes, and also cap models without catalog prices. `prefix` keeps labels unique.
 */
export function AmountFields({
  value,
  onChange,
  prefix = "",
}: {
  readonly value: AmountTexts;
  readonly onChange: (next: AmountTexts) => void;
  readonly prefix?: string;
}) {
  const field = (key: keyof AmountTexts, label: string, mode: "decimal" | "numeric") => (
    <label>
      {prefix}
      {label}
      <input
        inputMode={mode}
        value={value[key]}
        onChange={(e) => onChange({ ...value, [key]: e.target.value })}
      />
    </label>
  );
  return (
    <>
      {field("monthlyUsd", "Monthly ($)", "decimal")}
      {field("dailyUsd", "Daily ($)", "decimal")}
      {field("monthlyTokens", "Monthly (tokens)", "numeric")}
      {field("dailyTokens", "Daily (tokens)", "numeric")}
    </>
  );
}
