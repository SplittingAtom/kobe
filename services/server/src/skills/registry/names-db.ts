import { registrySkills, type KobeDb, type KobeTx } from "@kobe/db";
import { similarNames } from "./names.js";

/** Catalog names looking like `name` (SK24 typosquat hint), read from the Site's catalog. */
export async function similarCatalogNames(db: KobeDb | KobeTx, name: string): Promise<string[]> {
  const rows = await db.select({ name: registrySkills.name }).from(registrySkills);
  return similarNames(
    name,
    rows.map((r) => r.name),
  );
}
