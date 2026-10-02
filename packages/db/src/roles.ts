const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;

/** Quotes a Postgres role or table name, accepting only simple lowercase identifiers. */
export function quoteIdent(name: string): string {
  if (!IDENTIFIER.test(name)) {
    throw new Error(
      `Invalid role or table name "${name}": use lowercase letters, digits and _ (max 63)`,
    );
  }
  return `"${name}"`;
}
