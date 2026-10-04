"use client";

import { getInstallModels, type GatewayStatus } from "../../../lib/admin/api/install/models";
import { MutationStatus } from "../error-notice";
import { DateTime, ResourceView } from "../parts";
import { useMutation, useResource } from "../use-resource";
import { CatalogSection } from "./model-catalog";
import { ProvidersSection } from "./model-providers";
import styles from "../admin.module.css";

/**
 * Install console: models and providers (spec D6, D8, D30; KOBE-44 over KOBE-40's
 * `/v1/install/models`). Providers with write-only keys, the catalog, and whether the model
 * gateway (Bifrost) has caught up with the last change.
 */
export function InstallModelsPage() {
  const { state, reload } = useResource(getInstallModels);
  const mutation = useMutation();
  return (
    <>
      <h1>Models and providers</h1>
      <p className={styles.hint}>
        Add the model providers your install may use, then publish their models in the catalog under
        short aliases. Sandboxes reach models only through Kobe&apos;s model gateway, with a session
        token of their own; provider keys never enter a sandbox.
      </p>
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
      <p className={styles.banner} role="status">
        Model gateway: not configured on this install.
      </p>
    );
  }
  const failing = !gateway.inSync && gateway.lastError !== null;
  return (
    <section aria-labelledby="gateway-heading" className={failing ? styles.error : undefined}>
      <h2 id="gateway-heading">Model gateway</h2>
      <p role="status">
        {gateway.inSync
          ? "In sync: the gateway has every change."
          : failing
            ? "Not in sync: the last attempt to update the gateway failed. Kobe keeps retrying."
            : "Catching up: the latest change reaches the gateway within seconds."}
      </p>
      <dl className={styles.dl}>
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
            <dd>
              <code>{gateway.lastError}</code>
            </dd>
          </>
        )}
      </dl>
      <button type="button" onClick={onCheck}>
        Check again
      </button>
    </section>
  );
}
