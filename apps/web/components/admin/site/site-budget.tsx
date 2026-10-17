"use client";

import { useId, useState, type FormEvent } from "react";
import {
  getSiteBudget,
  setSiteBudget,
  type BudgetAmountsInput,
  type SiteLimits,
} from "../../../lib/admin/api/budgets";
import { AmountFields, parseAmounts, useAmountTexts } from "../budgets/amount-fields";
import { Button, Field, FieldError, FormRow, Section, TextInput } from "../../ui/console";
import { MutationStatus } from "../error-notice";
import { ResourceView } from "../parts";
import { useMutation, useResource } from "../use-resource";

/**
 * The site budget (spec D30, Bifrost's customer level; `/v1/site/budget`): every team's
 * spend counts against it, and the per-user request rate is every team's ceiling.
 */
export function SiteBudget() {
  const { state, reload } = useResource(getSiteBudget);
  const mutation = useMutation();
  return (
    <Section id="site-budget" title="Site budget">
      <MutationStatus error={mutation.error} notice={mutation.notice} />
      <ResourceView state={state} label="the site budget">
        {(limits) => (
          <Form
            key={limits.updatedAt}
            limits={limits}
            save={async (input) => {
              if (
                await mutation.run(
                  () => setSiteBudget(input),
                  () => "Site budget saved.",
                )
              ) {
                reload();
              }
            }}
          />
        )}
      </ResourceView>
    </Section>
  );
}

function Form({
  limits,
  save,
}: {
  readonly limits: SiteLimits;
  readonly save: (
    input: BudgetAmountsInput & { readonly user_requests_per_minute: number },
  ) => Promise<void>;
}) {
  const [amounts, setAmounts] = useAmountTexts(limits);
  const [rpm, setRpm] = useState(String(limits.userRequestsPerMinute));
  const [invalid, setInvalid] = useState<string | null>(null);
  const errorId = useId();

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
    <form
      onSubmit={submit}
      aria-label="Site budget limits"
      aria-describedby={invalid ? errorId : undefined}
    >
      {invalid && <FieldError id={errorId}>{invalid}</FieldError>}
      <FormRow>
        <AmountFields value={amounts} onChange={setAmounts} prefix="Site " />
        <Field label="Requests per minute per user">
          <TextInput
            inputMode="numeric"
            className="w-36"
            value={rpm}
            onChange={(e) => setRpm(e.target.value)}
          />
        </Field>
        <Button type="submit" variant="primary">
          Save site budget
        </Button>
      </FormRow>
      <p className="m-0 text-sm text-console-muted">
        Months and days are calendar periods in UTC. Token budgets count input, output and cached
        tokens and also cap models without prices.
      </p>
    </form>
  );
}
