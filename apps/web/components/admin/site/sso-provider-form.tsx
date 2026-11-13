"use client";

import { useState, type FormEvent } from "react";
import {
  createSsoProvider,
  testSsoTarget,
  updateSsoProvider,
  type DiscoveryReport,
  type SsoKind,
  type SsoProvider,
  type SsoProviderPatch,
  type SsoTarget,
} from "../../../lib/admin/api/site/sso";
import { Button, Field, FormRow, Section, Select, TextInput } from "../../ui/console";
import type { Mutation } from "../use-resource";
import { DiscoveryResult } from "./sso-discovery";

const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;

/**
 * Add or edit a console provider (KOBE-626). The client secret is write-only: empty on edit
 * means "unchanged", and the field is cleared after every save whatever the outcome. Test runs
 * discovery on what is typed without saving; saving runs it again and refuses on failure.
 */
export function SsoProviderForm({
  provider,
  callbackBase,
  mutation,
  onSaved,
  onCancel,
}: {
  /** Absent: a new provider. */
  readonly provider?: SsoProvider;
  /** `https://<kobe>/api/auth/sso/callback/`, to show the redirect URI as the slug is typed. */
  readonly callbackBase: string;
  readonly mutation: Mutation;
  readonly onSaved: () => void;
  readonly onCancel: () => void;
}) {
  const editing = provider !== undefined;
  const [kind, setKind] = useState<SsoKind>(provider?.kind ?? "entra");
  const [slug, setSlug] = useState(provider?.slug ?? "");
  const [displayName, setDisplayName] = useState(provider?.displayName ?? "");
  const [tenantId, setTenantId] = useState(provider?.tenantId ?? "");
  const [issuer, setIssuer] = useState(provider?.kind === "oidc" ? provider.issuer : "");
  const [clientId, setClientId] = useState(provider?.clientId ?? "");
  const [secret, setSecret] = useState("");
  const [accessClaim, setAccessClaim] = useState(provider?.accessClaim ?? "roles");
  const [report, setReport] = useState<DiscoveryReport | null>(null);
  const [slugError, setSlugError] = useState<string | null>(null);

  const target = (): SsoTarget =>
    kind === "entra" ? { kind, tenantId: tenantId.trim() } : { kind, issuer: issuer.trim() };

  async function test() {
    setReport(null);
    await mutation.run(
      () => testSsoTarget(target()),
      (r) => {
        setReport(r);
        return null;
      },
    );
  }

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!editing && !SLUG.test(slug)) {
      setSlugError("Use lowercase letters, digits and hyphens.");
      return;
    }
    setSlugError(null);
    setReport(null);
    const done = editing
      ? await mutation.run(
          () => updateSsoProvider(provider.id, patchOf()),
          () => `Saved ${displayName.trim()}.`,
        )
      : await mutation.run(
          () =>
            createSsoProvider({
              ...target(),
              slug,
              displayName: displayName.trim(),
              clientId: clientId.trim(),
              clientSecret: secret,
              accessClaim,
            }),
          () => `Added ${displayName.trim()}. Turn it on when the app registration is ready.`,
        );
    // Never kept on the page, whatever the outcome.
    setSecret("");
    if (done) onSaved();
  }

  function patchOf(): SsoProviderPatch {
    const where = kind === "entra" ? { tenantId: tenantId.trim() } : { issuer: issuer.trim() };
    return {
      displayName: displayName.trim(),
      clientId: clientId.trim(),
      accessClaim,
      ...where,
      ...(secret === "" ? {} : { clientSecret: secret }),
    };
  }

  return (
    <Section
      title={editing ? `Edit ${provider.displayName}` : "Add a provider"}
      actions={<Button onClick={onCancel}>Cancel</Button>}
    >
      <form onSubmit={save} aria-label={editing ? "Edit provider" : "Add a provider"}>
        <FormRow>
          <Field label="Kind">
            <Select
              value={kind}
              disabled={editing}
              onChange={(e) => setKind(e.target.value as SsoKind)}
            >
              <option value="entra">Microsoft Entra ID</option>
              <option value="oidc">Other OpenID Connect provider</option>
            </Select>
          </Field>
          <Field label="Display name" required>
            <TextInput
              maxLength={100}
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
            />
          </Field>
          <Field
            label="Slug"
            required
            error={slugError}
            hint={`Redirect URI: ${callbackBase}${slug || "<slug>"}`}
          >
            <TextInput
              maxLength={63}
              value={slug}
              disabled={editing}
              spellCheck={false}
              onChange={(e) => setSlug(e.target.value)}
            />
          </Field>
        </FormRow>
        <FormRow>
          {kind === "entra" ? (
            <Field
              label="Directory (tenant) ID"
              required
              hint="The GUID on the app registration's Overview. common, organizations and consumers are refused."
            >
              <TextInput
                spellCheck={false}
                maxLength={100}
                value={tenantId}
                onChange={(e) => setTenantId(e.target.value)}
              />
            </Field>
          ) : (
            <Field
              label="Issuer"
              required
              hint="Exactly as the provider's discovery document names it."
            >
              <TextInput
                type="url"
                spellCheck={false}
                maxLength={2048}
                value={issuer}
                onChange={(e) => setIssuer(e.target.value)}
              />
            </Field>
          )}
          <Field label="Client ID" required>
            <TextInput
              spellCheck={false}
              maxLength={256}
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
            />
          </Field>
          <Field
            label="Client secret"
            required={!editing}
            hint={
              editing
                ? "A secret is set. Leave empty to keep it; type a new one to replace it."
                : "Stored encrypted and never shown again."
            }
          >
            <TextInput
              type="password"
              autoComplete="off"
              spellCheck={false}
              maxLength={1024}
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
            />
          </Field>
          <Field label="Access from">
            <Select
              value={accessClaim}
              onChange={(e) => setAccessClaim(e.target.value as "roles" | "groups")}
            >
              <option value="roles">App roles (recommended)</option>
              <option value="groups">Groups</option>
            </Select>
          </Field>
        </FormRow>
        <FormRow className="mb-0">
          <Button disabled={mutation.pending} onClick={() => void test()}>
            Test discovery
          </Button>
          <Button type="submit" variant="primary" disabled={mutation.pending}>
            {editing ? "Save" : "Add provider"}
          </Button>
        </FormRow>
      </form>
      {report ? <DiscoveryResult report={report} /> : null}
    </Section>
  );
}
