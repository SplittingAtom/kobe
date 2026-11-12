"use client";

import { useState } from "react";
import type { SsoProvider } from "../../../lib/admin/api/site/sso";
import {
  LINKED_VIA_LABEL,
  expectSsoLink,
  getUserSsoLinks,
  unlinkUserSso,
  withdrawSsoLinkExpectation,
} from "../../../lib/admin/api/site/sso-links";
import type { SiteUser } from "../../../lib/admin/api/site/users";
import {
  Button,
  Field,
  FormRow,
  Section,
  Select,
  eventTrigger,
  useConfirm,
} from "../../ui/console";
import { MutationStatus } from "../error-notice";
import { DateTime, ResourceView } from "../parts";
import { useMutation, useResource } from "../use-resource";

/**
 * Site console → Users → a user → Single sign-on (KOBE-630, spec sso-oidc-scim §6): the user's
 * linked organization sign-ins (Unlink) and expected links (Withdraw), and **Expect SSO link**:
 * the next sign-in from the chosen provider with a verified address equal to the user's, in one of
 * the provider's verified domains, links automatically (single use, 14 days).
 */
export function UserSsoLinks({
  user,
  providers,
}: {
  readonly user: SiteUser;
  /** The site's providers (the Site console's list). */
  readonly providers: readonly SsoProvider[];
}) {
  const { state, reload } = useResource(() => getUserSsoLinks(user.id));
  const mutation = useMutation();
  const [confirm, confirmDialog] = useConfirm();
  const [providerId, setProviderId] = useState("");

  async function unlink(id: string, name: string, trigger: HTMLElement | null) {
    const yes = await confirm(
      {
        title: `Unlink ${user.name} from ${name}?`,
        description: `${user.name} can no longer sign in with ${name}, and those sessions end now.`,
        confirmLabel: "Unlink",
      },
      trigger,
    );
    if (!yes) return;
    if (
      await mutation.run(
        () => unlinkUserSso(user.id, id),
        () => `Unlinked from ${name}.`,
      )
    ) {
      reload();
    }
  }

  async function expect(provider: SsoProvider) {
    const done = await mutation.run(
      () => expectSsoLink(user.id, provider.id),
      () =>
        `${user.name}'s next sign-in with ${provider.displayName} links automatically (within 14 days).`,
    );
    if (done) reload();
  }

  async function withdraw(id: string) {
    if (
      await mutation.run(
        () => withdrawSsoLinkExpectation(user.id, id),
        () => "Withdrawn.",
      )
    ) {
      reload();
    }
  }

  return (
    <Section
      title={`Single sign-on: ${user.name}`}
      description="Email is never proof: an organization sign-in links by the person's own password or passkey sign-in, or by an expected link you set here."
    >
      <MutationStatus error={mutation.error} notice={mutation.notice} />
      <ResourceView state={state} label="links">
        {(data) => (
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {data.links.length === 0 && data.expectations.length === 0 && (
              <li>No organization sign-in is linked.</li>
            )}
            {data.links.map((l) => (
              <li key={`link-${l.providerId}`} className="flex flex-wrap items-center gap-2">
                <span>
                  {l.providerName}: {LINKED_VIA_LABEL[l.linkedVia]}, <DateTime value={l.linkedAt} />
                </span>
                <Button
                  size="sm"
                  variant="danger"
                  disabled={mutation.pending}
                  onClick={(e) => void unlink(l.providerId, l.providerName, eventTrigger(e))}
                >
                  Unlink<span className="sr-only"> {l.providerName}</span>
                </Button>
              </li>
            ))}
            {data.expectations.map((x) => (
              <li key={`expect-${x.providerId}`} className="flex flex-wrap items-center gap-2">
                <span>
                  {x.providerName}: link expected until <DateTime value={x.expiresAt} />
                </span>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={mutation.pending}
                  onClick={() => void withdraw(x.providerId)}
                >
                  Withdraw<span className="sr-only"> expected link to {x.providerName}</span>
                </Button>
              </li>
            ))}
          </ul>
        )}
      </ResourceView>
      {providers.length > 0 && (
        <FormRow className="mt-3">
          <Field
            label="Provider"
            hint="The user's email domain must be one of its verified domains."
          >
            <Select value={providerId} onChange={(e) => setProviderId(e.target.value)}>
              <option value="">Choose a provider</option>
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.displayName}
                </option>
              ))}
            </Select>
          </Field>
          <Button
            disabled={mutation.pending || providerId === ""}
            onClick={() => {
              const p = providers.find((x) => x.id === providerId);
              if (p) void expect(p);
            }}
          >
            Expect SSO link
          </Button>
        </FormRow>
      )}
      {confirmDialog}
    </Section>
  );
}
