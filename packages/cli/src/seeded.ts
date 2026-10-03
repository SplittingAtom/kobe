/**
 * Tables a fresh install already has rows in, because a migration seeds them. `kobe restore`
 * accepts these rows on a fresh target and replaces them with the backup's (inside the restore
 * transaction), instead of refusing the target as "already has data". Everything else must be
 * empty. Add a table here only with the migration that seeds it.
 */
export const SEEDED_TABLES: Readonly<Record<string, string>> = {
  egress_domains:
    "egress presets seeded by migration 0025_egress_rls (KOBE-38); the backup carries the install's own ceiling",
};

export function isSeeded(table: string): boolean {
  return Object.hasOwn(SEEDED_TABLES, table);
}
