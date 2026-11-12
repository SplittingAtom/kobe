import { ConfirmSsoLink } from "../../components/auth/confirm-sso-link";

/** Confirm linking an organization sign-in after a local sign-in (KOBE-630 review M1). */
export default function LinkSignInPage() {
  return (
    <main>
      <h1>Link your organization sign-in</h1>
      <ConfirmSsoLink />
    </main>
  );
}
