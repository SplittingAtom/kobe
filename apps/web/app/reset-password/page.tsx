"use client";

import { useEffect, useState, type FormEvent } from "react";
import { authClient } from "../../lib/auth-client";
import { tokenFromHash, validateNewPassword } from "../../lib/invites";

/** Choose a new password from a reset link (`#token=…`). Resetting signs out every session. */
export default function ResetPasswordPage() {
  const [token, setToken] = useState<string | null | undefined>(undefined);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setToken(tokenFromHash(window.location.hash));
    window.history.replaceState(null, "", window.location.pathname);
  }, []);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!token) return;
    const form = new FormData(e.currentTarget);
    const newPassword = String(form.get("password") ?? "");
    const problem = validateNewPassword(newPassword, String(form.get("confirm") ?? ""));
    if (problem) return setError(problem);
    const res = await authClient.resetPassword({ newPassword, token });
    if (res.error) return setError("This reset link is invalid or has expired. Request a new one.");
    setDone(true);
  }

  if (token === undefined)
    return (
      <main>
        <p>Loading…</p>
      </main>
    );
  if (done)
    return (
      <main>
        <h1>Password changed</h1>
        <p>
          You were signed out everywhere. <a href="/sign-in">Sign in</a> with your new password.
        </p>
      </main>
    );
  if (token === null)
    return (
      <main>
        <h1>Link not valid</h1>
        <p>
          <a href="/forgot-password">Request a new reset link.</a>
        </p>
      </main>
    );
  return (
    <main>
      <h1>Choose a new password</h1>
      <form onSubmit={onSubmit}>
        <label>
          New password{" "}
          <input
            name="password"
            type="password"
            autoComplete="new-password"
            minLength={12}
            maxLength={128}
            required
          />
        </label>
        <label>
          Confirm password{" "}
          <input name="confirm" type="password" autoComplete="new-password" required />
        </label>
        <button type="submit">Change password</button>
      </form>
      {error && <p role="alert">{error}</p>}
    </main>
  );
}
