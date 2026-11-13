"use client";

import { useEffect, useState } from "react";

export interface SsoProviderButton {
  readonly slug: string;
  readonly displayName: string;
}

/** Where a provider's sign-in starts; the server sanitizes `returnTo` again. */
export function ssoStartHref(slug: string, returnTo = "/"): string {
  return `/api/auth/sso/start/${encodeURIComponent(slug)}?returnTo=${encodeURIComponent(returnTo)}`;
}

/**
 * "Sign in with <provider>" buttons (KOBE-628, spec sso-oidc-scim §5): one per enabled provider,
 * read from the public `/api/auth/sso/providers`. Nothing is shown when single sign-on is off (the
 * route answers 404) or no provider is enabled. Each button is a plain link: the server redirects
 * to the identity provider.
 */
export function SsoSignIn({ returnTo = "/" }: { readonly returnTo?: string }) {
  const [providers, setProviders] = useState<readonly SsoProviderButton[]>([]);

  useEffect(() => {
    let live = true;
    fetch("/api/auth/sso/providers", { credentials: "same-origin" })
      .then(async (res) => (res.ok ? ((await res.json()) as { providers?: unknown }) : null))
      .then((body) => {
        if (!live || !body || !Array.isArray(body.providers)) return;
        setProviders(
          body.providers.filter(
            (p): p is SsoProviderButton =>
              typeof p === "object" &&
              p !== null &&
              typeof (p as SsoProviderButton).slug === "string" &&
              typeof (p as SsoProviderButton).displayName === "string",
          ),
        );
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  if (providers.length === 0) return null;
  return (
    <ul aria-label="Single sign-on">
      {providers.map((p) => (
        <li key={p.slug}>
          <a href={ssoStartHref(p.slug, returnTo)}>Sign in with {p.displayName}</a>
        </li>
      ))}
    </ul>
  );
}
