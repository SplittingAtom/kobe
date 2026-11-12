---
title: Signing in with your organization
summary: How to sign in with your organization's account (single sign-on), link it to an existing Kobe account, unlink it, and why accounts made this way have no Kobe password.
section: Getting started
order: 3
audience: member
---

If your site uses single sign-on, the sign-in page shows a **Sign in with _your organization_**
button (for example "Sign in with Contoso") above the passkey and password options. It takes you
to your organization's sign-in page and back to Kobe, signed in. Your organization decides who may
use Kobe and in which team, through the roles or groups it gives you.

## Your first sign-in

If your organization gave you access and you have no Kobe account yet, the first sign-in creates
one and puts you in the teams your access names. There is no invitation and no password to
choose.

If the page says your organization's sign-in **can't be used for this site yet**, either your
organization has not given you access to Kobe (ask your administrator), or you already have a Kobe
account with that address (link it, below). Kobe shows the same message in both cases, so the page
never reveals who has an account.

## Linking an account you already have

Kobe never joins your organization's sign-in to an existing account just because the address
matches. To link them:

1. Press **Sign in with _your organization_** and sign in there. Kobe comes back with "can't be
   used for this site yet".
2. Within 10 minutes, sign in on the same page with your Kobe **password** (and authenticator
   code, if you use one) or your **passkey**.
3. Kobe opens **Link your organization sign-in**, naming the organization and the address. Press
   **Link _organization_** if you just signed in there yourself, or **Don't link**.

From then on both work: your organization's button and your password or passkey. An administrator
can also prepare the link for you; then your next sign-in with your organization links on its own.

## Sign-in methods

**Profile → Sign-in methods** lists the organization sign-ins linked to your account, how each was
linked and when you last used it. **Unlink** stops that sign-in and ends the sessions you started
with it; your password and passkeys stay. You can't unlink your only way to sign in.

## No password for accounts your organization made

An account created by your organization's sign-in (or provisioned by your organization) has no
Kobe password, passkey or authenticator app, and can't add one: **Forgot your password?** sends
nothing for it. That way, when your organization disables your account, nothing in Kobe outlives
it. Sign in with the organization's button. Accounts that existed before and were linked keep
their password and passkeys.

## Two-factor sign-in

If your site requires two-factor authentication, Kobe does not ask for an authenticator code after
an organization sign-in: your organization's own multi-factor authentication counts instead. If
your organization's sign-in did not include it, Kobe refuses the sign-in; ask your administrator.

## Signing out and being signed out

**Sign out** in the profile menu ends your Kobe session only, not your organization's sign-in.
Kobe signs you out by itself when your organization deactivates your account, when an
administrator turns that sign-in off or unlinks it, or when the site's maximum session length for
organization sign-ins has passed. Sign in again; if you can't, ask your administrator.

See [Troubleshooting](../reference/troubleshooting.md#single-sign-on) for each message on the
sign-in page.
