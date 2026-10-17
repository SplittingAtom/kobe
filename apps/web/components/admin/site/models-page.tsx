"use client";

import { getSiteModels, type GatewayStatus } from "../../../lib/admin/api/site/models";
import { Button, Notice, PageHeader, Section } from "../../ui/console";
import { MutationStatus } from "../error-notice";
import { DateTime, ResourceView } from "../parts";
import { useMutation, useResource } from "../use-resource";
import { CatalogSection } from "./model-catalog";
import { ProvidersSection } from "./model-providers";

/** A definition list of label and value pairs, side by side. */
const DL = "m-0 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 [&_dd]:m-0 [&_dt]:font-medium";

/**
 * Site console: models and providers (spec D6, D8, D30; KOBE-44 over KOBE-40's
 * `/v1/site/models`). Providers with write-only keys, the catalog, and whether the model
 * gateway (Bifrost) has caught up with the last change.
 */
export function SiteModelsPage() {
  const { state, reload } = useResource(getSiteModels);
  const mutation = useMutation();
  return (
    <>
      <PageHeader
        title="Models and providers"
        description="Add the model providers your site may use, then publish their models in the catalog under short aliases. Sandboxes reach models only through Kobe's model gateway, with a session token of their own; provider keys never enter a sandbox."
      />
      <MutationStatus error={mutation.error} notice={mutation.notice} />
      <ResourceView state={state} label="models">
        {(data) => (
          <>
            <GatewayStatusView
              gateway={data.gateway}
              configured={data.configured}
              onCheck={reload}
            />
            <ProvidersSection
              providers={data.providers}
              catalog={data.catalog}
              configured={data.configured}
              mutation={mutation}
              onChanged={reload}
            />
            <CatalogSection
              catalog={data.catalog}
              providers={data.providers}
              tokenDefaults={data.tokenDefaults}
              mutation={mutation}
              onChanged={reload}
            />
          </>
        )}
      </ResourceView>
    </>
  );
}

/** Sync with Bifrost (KOBE-40 `gateway`): in sync, catching up, or failing with its last error. */
export function GatewayStatusView({
  gateway,
  configured,
  onCheck,
}: {
  readonly gateway: GatewayStatus;
  readonly configured: boolean;
  readonly onCheck: () => void;
}) {
  if (!configured) {
    return (
      <Notice tone="warn" role="status">
        <p>Model gateway: not configured on this site.</p>
      </Notice>
    );
  }
  const failing = !gateway.inSync && gateway.lastError !== null;
  const details = (
    <dl className={DL}>
      <dt>Last synced</dt>
      <dd>
        <DateTime value={gateway.lastSyncedAt} />
      </dd>
      <dt>Last attempt</dt>
      <dd>
        <DateTime value={gateway.lastAttemptAt} />
      </dd>
      {gateway.lastError !== null && (
        <>
          <dt>Last error</dt>
          <dd className="break-all">
            <code>{gateway.lastError}</code>
          </dd>
        </>
      )}
    </dl>
  );
  const body = (
    <>
      {/* A live region in every state, so a change after "Check again" is announced. */}
      <p role="status">
        {gateway.inSync
          ? "In sync: the gateway has every change."
          : failing
            ? "Not in sync: the last attempt to update the gateway failed. Kobe keeps retrying."
            : "Catching up: the latest change reaches the gateway within seconds."}
      </p>
      {details}
    </>
  );
  const check = (
    <Button size="sm" onClick={onCheck}>
      Check again
    </Button>
  );
  return (
    <Section id="gateway-heading" title="Model gateway">
      {failing ? (
        // The error colours only: the status above already announces it, so no second alert.
        <Notice tone="error" role="none" actions={check}>
          {body}
        </Notice>
      ) : (
        <>
          {body}
          <div className="mt-2">{check}</div>
        </>
      )}
    </Section>
  );
}
