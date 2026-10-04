"use client";

import { useState, type FormEvent } from "react";
import {
  getInstallBudget,
  parseAmount,
  setInstallBudget,
  type InstallLimits,
} from "../../../lib/admin/api/budgets";
import { MutationStatus } from "../error-notice";
import { ResourceView } from "../parts";
import { useMutation, useResource } from "../use-resource";
import styles from "../admin.module.css";

const text = (v: number | null) => (v === null ? "" : String(v));

/**
 * The install budget (spec D30, Bifrost's customer level; `/v1/install/budget`): every team's
 * spend counts against it, and the per-user request rate is every team's ceiling.
 */
export function InstallBudget() {
  const { state, reload } = useResource(getInstallBudget);
  const mutation = useMutation();
  return (
    <section aria-labelledby="install-budget">
      <h2 id="install-budget">Install budget</h2>
      <MutationStatus error={mutation.error} notice={mutation.notice} />
      <ResourceView state={state} label="the install budget">
        {(limits) => (
          <Form
            key={limits.updatedAt}
            limits={limits}
            save={async (input) => {
              if (
                await mutation.run(
                  () => setInstallBudget(input),
                  () => "Install budget saved.",
                )
              ) {
                reload();
              }
            }}
          />
        )}
      </ResourceView>
    </section>
  );
}

function Form({
  limits,
  save,
}: {
  readonly limits: InstallLimits;
  readonly save: (input: {
    monthly_usd: number | null;
    daily_usd: number | null;
    user_requests_per_minute: number;
  }) => Promise<void>;
}) {
  const [monthly, setMonthly] = useState(text(limits.monthlyUsd));
  const [daily, setDaily] = useState(text(limits.dailyUsd));
  const [rpm, setRpm] = useState(String(limits.userRequestsPerMinute));
  const [invalid, setInvalid] = useState<string | null>(null);

  function submit(e: FormEvent) {
    e.preventDefault();
    const m = parseAmount(monthly);
    const d = parseAmount(daily);
    const r = Number(rpm);
    if (m === undefined || d === undefined || !Number.isInteger(r) || r < 1 || r > 10_000) {
      setInvalid(
        "Budgets are dollar amounts (or empty); the rate is a whole number from 1 to 10000.",
      );
      return;
    }
    setInvalid(null);
    void save({ monthly_usd: m, daily_usd: d, user_requests_per_minute: r });
  }

  return (
    <form className={styles.form} onSubmit={submit}>
      {invalid && (
        <p role="alert" className={styles.error}>
          {invalid}
        </p>
      )}
      <label>
        Monthly budget ($)
        <input inputMode="decimal" value={monthly} onChange={(e) => setMonthly(e.target.value)} />
      </label>
      <label>
        Daily cap ($)
        <input inputMode="decimal" value={daily} onChange={(e) => setDaily(e.target.value)} />
      </label>
      <label>
        Requests per minute per user
        <input inputMode="numeric" value={rpm} onChange={(e) => setRpm(e.target.value)} />
      </label>
      <button type="submit">Save install budget</button>
    </form>
  );
}
