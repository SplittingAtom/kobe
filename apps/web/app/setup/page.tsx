"use client";

import { useEffect, useState, type FormEvent } from "react";
import { validateSetup } from "../../lib/setup";

/** First-run wizard: creates the Owner while Kobe has no users, then disables itself. */
export default function SetupPage() {
  const [required, setRequired] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    fetch("/v1/setup")
      .then((r) => r.json() as Promise<{ required: boolean }>)
      .then((d) => setRequired(d.required))
      .catch(() => setError("Could not reach the Kobe server."));
  }, []);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const setupToken = String(form.get("setupToken") ?? "").trim();
    const input = {
      email: String(form.get("email") ?? ""),
      name: String(form.get("name") ?? ""),
      password: String(form.get("password") ?? ""),
    };
    const problem = validateSetup(input);
    if (problem) return setError(problem);
    const res = await fetch("/v1/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...input, setupToken }),
    });
    if (res.status === 201) setDone(true);
    else if (res.status === 409) setRequired(false);
    else if (res.status === 403)
      setError("The setup token is wrong. Copy it from the command in the Helm install notes.");
    else setError("Setup failed. Check the details and try again.");
  }

  if (done)
    return (
      <main>
        <h1>Owner created</h1>
        <p>
          <a href="/sign-in">Sign in</a> to finish setting up Kobe.
        </p>
      </main>
    );
  if (required === false)
    return (
      <main>
        <h1>Kobe is set up</h1>
        <p>
          <a href="/sign-in">Sign in</a>
        </p>
      </main>
    );
  if (required === null)
    return (
      <main>
        <p>{error ?? "Loading…"}</p>
      </main>
    );
  return (
    <main>
      <h1>Set up Kobe</h1>
      <p>Create the Owner account. You can invite everyone else afterwards.</p>
      <form onSubmit={onSubmit}>
        <label>
          Setup token <input name="setupToken" autoComplete="off" spellCheck={false} required />
        </label>
        <p>
          Prove you control this install: run the <code>kubectl … setup-token</code> command printed
          by <code>helm install</code>.
        </p>
        <label>
          Name <input name="name" autoComplete="name" required />
        </label>
        <label>
          Email <input name="email" type="email" autoComplete="email" required />
        </label>
        <label>
          Password{" "}
          <input
            name="password"
            type="password"
            autoComplete="new-password"
            minLength={12}
            required
          />
        </label>
        {error && <p role="alert">{error}</p>}
        <button type="submit">Create Owner</button>
      </form>
    </main>
  );
}
