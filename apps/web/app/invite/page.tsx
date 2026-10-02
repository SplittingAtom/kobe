"use client";

import { useEffect, useState, type FormEvent } from "react";
import { tokenFromHash, validateNewPassword } from "../../lib/invites";

type State =
  | { readonly step: "checking" }
  | { readonly step: "invalid" }
  | { readonly step: "form"; readonly token: string; readonly email: string };

/** Accept an install invitation (U1): choose a name and password, then land signed in. */
export default function InvitePage() {
  const [state, setState] = useState<State>({ step: "checking" });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const token = tokenFromHash(window.location.hash);
    // Keep the token out of the address bar and history.
    window.history.replaceState(null, "", window.location.pathname);
    if (!token) return setState({ step: "invalid" });
    fetch("/api/auth/invitation/lookup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    })
      .then(async (r) => {
        if (!r.ok) return setState({ step: "invalid" });
        const { email } = (await r.json()) as { email: string };
        setState({ step: "form", token, email });
      })
      .catch(() => setError("Could not reach the Kobe server."));
  }, []);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (state.step !== "form") return;
    const form = new FormData(e.currentTarget);
    const name = String(form.get("name") ?? "").trim();
    const password = String(form.get("password") ?? "");
    const problem = validateNewPassword(password, String(form.get("confirm") ?? ""));
    if (!name) return setError("Enter your name.");
    if (problem) return setError(problem);
    const res = await fetch("/api/auth/invitation/accept", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: state.token, name, password }),
    });
    if (res.ok) return window.location.assign("/");
    if (res.status === 429) return setError("Too many attempts. Wait a minute and try again.");
    setState({ step: "invalid" });
  }

  if (state.step === "checking")
    return (
      <main>
        <p>{error ?? "Checking your invitation…"}</p>
      </main>
    );
  if (state.step === "invalid")
    return (
      <main>
        <h1>Invitation not valid</h1>
        <p>
          This invitation link is invalid, already used, or expired. Ask an admin for a new one.
        </p>
      </main>
    );
  return (
    <main>
      <h1>Join Kobe</h1>
      <p>
        You were invited as <strong>{state.email}</strong>. Choose a name and a password; you can
        add a passkey after signing in.
      </p>
      <form onSubmit={onSubmit}>
        <label>
          Name <input name="name" autoComplete="name" maxLength={100} required />
        </label>
        <label>
          Password{" "}
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
        <button type="submit">Create account</button>
      </form>
      {error && <p role="alert">{error}</p>}
    </main>
  );
}
