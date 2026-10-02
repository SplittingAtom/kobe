/**
 * Tables whose rows are never backed up, with the reason. Everything else in `public` is backed up
 * automatically, so a table added by a later migration is covered without touching this file.
 *
 * Add a table here only when its rows are bearer credentials, one-time tokens, key material that
 * is regenerated on demand, or throwaway counters. Secrets the product needs after a restore
 * (connector grants, header injection) are stored encrypted under a key held in a Kubernetes
 * Secret and stay in the backup as ciphertext.
 */
export const EXCLUDED_TABLES: Readonly<Record<string, string>> = {
  sessions:
    "session tokens are bearer credentials; a restored install signs everyone in again (D7 revocation)",
  verifications: "one-time email-verification and password-reset tokens, short-lived and secret",
  jwks: "JWT signing keys; the server generates a new key on first use, so backups carry no signing keys",
  rate_limits: "throwaway rate-limit counters",
};

export function isExcluded(table: string): boolean {
  return Object.hasOwn(EXCLUDED_TABLES, table);
}
