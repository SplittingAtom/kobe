"use client";

import {
  SEMANTIC_MEMORY_NEAR_FULL_RATIO,
  SEMANTIC_MEMORY_POLICY_MAX_BYTES,
  SEMANTIC_MEMORY_POLICY_MAX_ITEMS,
} from "@kobe/protocol";
import { useMemo } from "react";
import {
  createMemoryItemsApi,
  describeItemError,
  type MemoryItemList,
} from "../../lib/memory/items-api";
import { visible } from "../../lib/security/visible";
import { ResourceView } from "../admin/parts";
import { useResource } from "../admin/use-resource";
import { EmptyState, Notice, Section } from "../ui/console";

function Meter({
  label,
  value,
  max,
  unit,
}: {
  readonly label: string;
  readonly value: number;
  readonly max: number;
  readonly unit: string;
}) {
  const text = `${value} of ${max} ${unit}`;
  return (
    <div className="flex min-w-48 flex-col gap-1">
      <span className="text-sm">
        {label}: {text}
      </span>
      <meter
        aria-label={label}
        aria-valuetext={text}
        min={0}
        max={max}
        low={Math.ceil(max * SEMANTIC_MEMORY_NEAR_FULL_RATIO)}
        high={max}
        optimum={0}
        value={Math.min(value, max)}
        className="w-full"
      />
    </div>
  );
}

/**
 * The Site's Policy budget (SM23, KOBE-385): active Policy items of 25 and bytes of 2 KiB, as
 * meters that warn from 80%. Policy is always given to every agent, so the budget is small.
 */
export function PolicyBudget({ usage }: { readonly usage: MemoryItemList["usage"] }) {
  if (usage.policyCount === undefined || usage.policyBytes === undefined) return null;
  const items = usage.policyCount;
  const bytes = usage.policyBytes;
  const near = (v: number, max: number) => v >= Math.ceil(max * SEMANTIC_MEMORY_NEAR_FULL_RATIO);
  const full =
    items >= SEMANTIC_MEMORY_POLICY_MAX_ITEMS || bytes >= SEMANTIC_MEMORY_POLICY_MAX_BYTES;
  return (
    <div className="mb-3" role="group" aria-label="Policy budget">
      <div className="flex flex-wrap gap-6">
        <Meter
          label="Policy items"
          value={items}
          max={SEMANTIC_MEMORY_POLICY_MAX_ITEMS}
          unit="items"
        />
        <Meter
          label="Policy text"
          value={bytes}
          max={SEMANTIC_MEMORY_POLICY_MAX_BYTES}
          unit="bytes"
        />
      </div>
      {full ? (
        <Notice tone="warn" title="Policy is full">
          <p>Remove a Policy item or shorten one before adding more.</p>
        </Notice>
      ) : (
        (near(items, SEMANTIC_MEMORY_POLICY_MAX_ITEMS) ||
          near(bytes, SEMANTIC_MEMORY_POLICY_MAX_BYTES)) && (
          <Notice tone="info" title="Policy is nearly full">
            <p>Keep Policy short: every agent reads all of it in every run.</p>
          </Notice>
        )
      )}
    </div>
  );
}

/**
 * Site Policy as text, read-only (KOBE-385): Team admins see what every agent in their workspace
 * is told, and change none of it. Plain text; hidden characters escaped.
 */
export function PolicyReadOnly({ teamId }: { readonly teamId: string }) {
  const api = useMemo(() => createMemoryItemsApi(teamId), [teamId]);
  const { state } = useResource(async () => {
    const res = await api.list({ scope: "site", status: "active", policy: true });
    return res.ok
      ? res
      : { ...res, error: { ...res.error, message: describeItemError(res.error) } };
  });
  return (
    <Section
      id="site-policy"
      title="Site Policy"
      description="Every agent in this workspace is given this text in every run. Only Site admins change it."
    >
      <ResourceView state={state} label="Site Policy">
        {(list) =>
          list.items.length === 0 ? (
            <EmptyState title="No Policy.">The site has set no Policy.</EmptyState>
          ) : (
            <ul aria-label="Site Policy" className="m-0 flex list-none flex-col gap-2 p-0">
              {list.items.map((item) => (
                <li
                  key={item.id}
                  className="box-border rounded-md border border-console-border p-3 [overflow-wrap:anywhere] whitespace-pre-wrap"
                >
                  {visible(item.statement)}
                </li>
              ))}
            </ul>
          )
        }
      </ResourceView>
    </Section>
  );
}
