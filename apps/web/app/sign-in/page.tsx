"use client";

import { useEffect, useState, type FormEvent } from "react";
import { SsoSignIn } from "../../components/auth/sso-sign-in";
import { useBranding } from "../../components/shell/branding-context";
import { getPendingSsoLink } from "../../lib/admin/api/site/sso-links";
import { authClient } from "../../lib/auth-client";
import { ssoErrorMessage } from "../../lib/sso-errors";

/**
 * Sign in with single sign-on (one button per enabled provider, KOBE-628), a passkey, or email +
 * password followed by a TOTP code when 2FA is enrolled. A failed SSO sign-in comes back here with
 * `?sso_error=<code>`, shown as a plain message.
 */
export default function SignInPage() {
  const [step, setStep] = useState<"password" | "totp">("password");
  const [error, setError] = useState<string | null>(null);
  const { appName } = useBranding();

  useEffect(() => {
    const message = ssoErrorMessage(new URLSearchParams(window.location.search).get("sso_error"));
    if (message) setError(message);
  }, []);

  // A local sign-in that followed an SSO attempt may have staged a link: confirm it first
  // (KOBE-630 review M1); otherwise straight to the app.
  const done = async () => {
    const pending = await getPendingSsoLink().catch(() => null);
    window.location.assign(pending?.ok && pending.data ? "/link-sign-in" : "/");
  };

  async function onPassword(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const res = await authClient.signIn.email({
      email: String(form.get("email") ?? ""),
      password: String(form.get("password") ?? ""),
    });
    if (res.error) return setError("Email or password is incorrect.");
    if ((res.data as { twoFactorRedirect?: boolean } | null)?.twoFactorRedirect)
      return setStep("totp");
    await done();
  }

  async function onTotp(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const code = String(new FormData(e.currentTarget).get("code") ?? "");
    const res = await authClient.twoFactor.verifyTotp({ code });
    if (res.error) return setError("That code didn't work. Try the current one.");
    await done();
  }

  async function onPasskey() {
    const res = await authClient.signIn.passkey();
    if (res?.error) return setError("Passkey sign-in failed.");
    await done();
  }

  return (
    <main>
      <h1>Sign in to {appName}</h1>
      {step === "password" ? (
        <>
          <SsoSignIn />
          <button type="button" onClick={onPasskey}>
            Sign in with a passkey
          </button>
          <form onSubmit={onPassword}>
            <label>
              Email <input name="email" type="email" autoComplete="username webauthn" required />
            </label>
            <label>
              Password{" "}
              <input name="password" type="password" autoComplete="current-password" required />
            </label>
            <button type="submit">Sign in</button>
          </form>
          <p>
            <a href="/forgot-password">Forgot your password?</a>
          </p>
        </>
      ) : (
        <form onSubmit={onTotp}>
          <label>
            Authenticator code{" "}
            <input
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              required
            />
          </label>
          <button type="submit">Verify</button>
        </form>
      )}
      {error && <p role="alert">{error}</p>}
    </main>
  );
}
