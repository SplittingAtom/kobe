"use client";

import { useEffect, useState } from "react";
import {
  confirmPendingSsoLink,
  discardPendingSsoLink,
  getPendingSsoLink,
  type PendingSsoLink,
} from "../../lib/admin/api/site/sso-links";

type State =
  | { readonly status: "loading" }
  | { readonly status: "none" }
  | { readonly status: "ask"; readonly pending: PendingSsoLink }
  | { readonly status: "error"; readonly message: string };

/**
 * The confirmation step of linking an organization sign-in to a local account (KOBE-630 review
 * M1): after a local sign-in that followed an SSO attempt, the person sees which provider and
 * which address would be linked and decides. Nothing is linked without **Link**.
 */
export function ConfirmSsoLink({
  onDone = () => window.location.assign("/"),
}: {
  readonly onDone?: () => void;
}) {
  const [state, setState] = useState<State>({ status: "loading" });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let current = true;
    void getPendingSsoLink().then(
      (res) => {
        if (!current) return;
        setState(res.ok && res.data ? { status: "ask", pending: res.data } : { status: "none" });
      },
      () => current && setState({ status: "none" }),
    );
    return () => {
      current = false;
    };
  }, []);

  async function decide(link: boolean) {
    setBusy(true);
    const res = await (link ? confirmPendingSsoLink() : discardPendingSsoLink()).catch(() => null);
    setBusy(false);
    if (link && (!res || !res.ok)) {
      setState({
        status: "error",
        message: res && !res.ok ? res.error.message : "The link could not be made.",
      });
      return;
    }
    onDone();
  }

  if (state.status === "loading") return <p role="status">Checking…</p>;
  if (state.status === "none") {
    return (
      <>
        <p>Nothing is waiting to be linked.</p>
        <button type="button" onClick={onDone}>
          Continue
        </button>
      </>
    );
  }
  if (state.status === "error") {
    return (
      <>
        <p role="alert">{state.message}</p>
        <button type="button" onClick={onDone}>
          Continue
        </button>
      </>
    );
  }
  const { providerName, email } = state.pending;
  return (
    <>
      <p>
        Link the {providerName} sign-in <strong>{email}</strong> to your account? After that you can
        also sign in with {providerName}. Only link it if you just signed in with {providerName}{" "}
        yourself.
      </p>
      <button type="button" disabled={busy} onClick={() => void decide(true)}>
        Link {providerName}
      </button>{" "}
      <button type="button" disabled={busy} onClick={() => void decide(false)}>
        Don&apos;t link
      </button>
    </>
  );
}
