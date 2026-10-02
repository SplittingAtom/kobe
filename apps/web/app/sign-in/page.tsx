"use client";

import { useState, type FormEvent } from "react";
import { authClient } from "../../lib/auth-client";

/** Sign in with a passkey, or email + password followed by a TOTP code when 2FA is enrolled. */
export default function SignInPage() {
  const [step, setStep] = useState<"password" | "totp">("password");
  const [error, setError] = useState<string | null>(null);

  const done = () => window.location.assign("/");

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
    done();
  }

  async function onTotp(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const code = String(new FormData(e.currentTarget).get("code") ?? "");
    const res = await authClient.twoFactor.verifyTotp({ code });
    if (res.error) return setError("That code didn't work. Try the current one.");
    done();
  }

  async function onPasskey() {
    const res = await authClient.signIn.passkey();
    if (res?.error) return setError("Passkey sign-in failed.");
    done();
  }

  return (
    <main>
      <h1>Sign in to Kobe</h1>
      {step === "password" ? (
        <>
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
