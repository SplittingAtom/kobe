/**
 * Plain messages for the `sso_error` codes the server's single sign-on callback redirects with
 * (KOBE-628, spec sso-oidc-scim §5.7). They never echo anything from the identity provider.
 */
const MESSAGES: Readonly<Record<string, string>> = {
  no_access:
    "Your organization has not given you access to this site. Ask your administrator to assign you to it.",
  link_required:
    "An account with this email address already exists. Sign in with your password or passkey; an administrator can link it to your organization's sign-in.",
  deactivated: "This account is deactivated. Ask a site admin to reactivate it.",
  mfa_missing:
    "Your organization's sign-in did not include multi-factor authentication, which this site requires. Ask your administrator about Conditional Access.",
  groups_overage:
    "Your organization's sign-in carried too many groups for this site to read. Ask your administrator to use app roles or send only the groups assigned to the application.",
  tenant_mismatch: "That sign-in came from a different organization than the one this site trusts.",
  email_missing:
    "Your organization's sign-in did not include an email address, so no account could be created. Ask your administrator.",
  state_invalid: "That sign-in link expired or was already used. Start again.",
  token_invalid: "Your organization's sign-in could not be verified. Start again.",
  idp_error: "Sign-in was cancelled or refused by your organization's identity provider.",
  idp_unreachable:
    "Your organization's identity provider could not be reached. Try again later, or sign in with your password or passkey.",
  provider_unavailable: "That sign-in option is not available right now.",
};

const FALLBACK =
  "Single sign-on did not work. Start again, or sign in with your password or passkey.";

/** The message for an `sso_error` code; null when there is no code. */
export function ssoErrorMessage(code: string | null | undefined): string | null {
  if (!code) return null;
  return MESSAGES[code] ?? FALLBACK;
}
