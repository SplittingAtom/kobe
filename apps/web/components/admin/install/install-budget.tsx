"use client";

import { useState, type FormEvent } from "react";
import {
  getInstallBudget,
  setInstallBudget,
  type BudgetAmountsInput,
  type InstallLimits,
} from "../../../lib/admin/api/budgets";
import { AmountFields, parseAmounts, useAmountTexts } from "../budgets/amount-fields";
import { MutationStatus } from "../error-notice";
import { ResourceView } from "../parts";
import { useMutation, useResource } from "../use-resource";
import styles from "../admin.module.css";

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
  readonly save: (
    input: BudgetAmountsInput & { readonly user_requests_per_minute: number },
  ) => Promise<void>;
}) {
  const [amounts, setAmounts] = useAmountTexts(limits);
  const [rpm, setRpm] = useState(String(limits.userRequestsPerMinute));
  const [invalid, setInvalid] = useState<string | null>(null);

  function submit(e: FormEvent) {
    e.preventDefault();
    const parsed = parseAmounts(amounts);
    const r = Number(rpm);
    if (typeof parsed === "string") return setInvalid(parsed);
    if (!Number.isInteger(r) || r < 1 || r > 10_000) {
      return setInvalid("The request rate is a whole number from 1 to 10000.");
    }
    setInvalid(null);
    void save({ ...parsed, user_requests_per_minute: r });
  }

  return (
    <form className={styles.form} onSubmit={submit}>
      {invalid && (
        <p role="alert" className={styles.error}>
          {invalid}
        </p>
      )}
      <AmountFields value={amounts} onChange={setAmounts} prefix="Install " />
      <label>
        Requests per minute per user
        <input inputMode="numeric" value={rpm} onChange={(e) => setRpm(e.target.value)} />
      </label>
      <button type="submit">Save install budget</button>
      <p className={styles.hint}>
        Months and days are calendar periods in UTC. Token budgets count input, output and cached
        tokens and also cap models without prices.
      </p>
    </form>
  );
}
