"use client";

import { useState, type FormEvent } from "react";
import { authClient } from "../../lib/auth-client";

/** Ask for a reset link. The answer never says whether the address has an account. */
export default function ForgotPasswordPage() {
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const email = String(new FormData(e.currentTarget).get("email") ?? "");
    const res = await authClient.requestPasswordReset({ email });
    if (res.error?.status === 429) return setError("Too many requests. Try again in a minute.");
    setSent(true);
  }

  if (sent)
    return (
      <main>
        <h1>Check your email</h1>
        <p>
          If that address has a Kobe account, a reset link is on its way. It works for 30 minutes.
        </p>
      </main>
    );
  return (
    <main>
      <h1>Reset your password</h1>
      <form onSubmit={onSubmit}>
        <label>
          Email <input name="email" type="email" autoComplete="username" required />
        </label>
        <button type="submit">Send reset link</button>
      </form>
      {error && <p role="alert">{error}</p>}
    </main>
  );
}
