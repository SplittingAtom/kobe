import {
  connectorGrants,
  modelGatewayKeys,
  modelProviders,
  scanTeams,
  sql,
  teamEgress,
  webSearchSettings,
  type KobeDb,
  type KobeTx,
} from "@kobe/db";
import type { Logger } from "pino";

type SQL = ReturnType<typeof sql>;

/**
 * Start-up check of the sealed values in Postgres (KOBE-425). Every sealed value names the key it
 * was sealed with (`<version>.<key id>.…`, SecretBox and Envelope alike; the id is derived from the
 * key, not secret). A value whose key this server does not hold can never be opened: the Secret
 * holding that key is not the one the value was written with. It happens after a restore with
 * other Secrets (docs/backup-restore.md, "Secrets"), so each such family is named in one error
 * line, with the Secret to put back, instead of failing later deep inside a sync or a run.
 * Nothing is decrypted, and the server starts regardless.
 */
export interface SealedFamily {
  /** What is sealed, as people say it ("model provider API keys"). */
  readonly name: string;
  /** Where its key lives: the Secret (and its values key) an operator must put back. */
  readonly secret: string;
  /** The ids of the keys this process holds for it. */
  readonly keyIds: readonly string[];
  /** Site table: one query, `kid` and `n` per key id. */
  readonly site?: SQL;
  /** Team table: the same query, run per team (RLS). */
  readonly team?: SQL;
}

export interface SealedFinding {
  readonly name: string;
  readonly secret: string;
  /** Rows sealed with a key this server does not hold. */
  readonly rows: number;
  readonly unknownKeyIds: readonly string[];
}

type KidRows = ReadonlyMap<string, number>;

/** The rows whose key id is not held. */
export function unknownKeys(
  found: KidRows,
  held: readonly string[],
): Omit<SealedFinding, "name" | "secret"> {
  const ids = [...found.keys()].filter((kid) => !held.includes(kid)).sort();
  return { rows: ids.reduce((n, kid) => n + (found.get(kid) ?? 0), 0), unknownKeyIds: ids };
}

const kidCount = (col: SQL, from: SQL): SQL =>
  sql`SELECT split_part(${col}, '.', 2) AS kid, count(*)::int AS n FROM ${from} WHERE ${col} IS NOT NULL GROUP BY 1`;

/** The sealed families this server holds keys for (a family without its key is off anyway). */
export function sealedFamilies(keys: {
  readonly providerKeyIds?: readonly string[];
  readonly virtualKeyIds?: readonly string[];
  readonly envelopeKeyIds?: readonly string[];
  readonly egressHeaderKeyIds?: readonly string[];
}): SealedFamily[] {
  const families: SealedFamily[] = [];
  const modelKeys = "the model keys Secret (`<release>-model-keys` or `bifrost.keysSecret`)";
  if (keys.providerKeyIds) {
    families.push({
      name: "model provider API keys",
      secret: `${modelKeys}, key provider-keys`,
      keyIds: keys.providerKeyIds,
      site: kidCount(sql`${modelProviders.apiKeyEnc}`, sql`${modelProviders}`),
    });
  }
  if (keys.virtualKeyIds) {
    families.push({
      name: "members' model gateway virtual keys",
      secret: `${modelKeys}, key virtual-keys`,
      keyIds: keys.virtualKeyIds,
      team: kidCount(sql`${modelGatewayKeys.vkValueEnc}`, sql`${modelGatewayKeys}`),
    });
  }
  if (keys.envelopeKeyIds) {
    const envelope = "the envelope key Secret (`<release>-envelope-key` or `envelope.keySecret`)";
    families.push(
      {
        name: "connector credentials",
        secret: envelope,
        keyIds: keys.envelopeKeyIds,
        team: kidCount(sql`${connectorGrants.sealed}`, sql`${connectorGrants}`),
      },
      {
        name: "the web search API key",
        secret: envelope,
        keyIds: keys.envelopeKeyIds,
        site: kidCount(sql`${webSearchSettings.sealed}`, sql`${webSearchSettings}`),
      },
    );
  }
  if (keys.egressHeaderKeyIds) {
    families.push({
      name: "injected egress header values",
      secret: "the egress header Secret (`<release>-egress-headers` or `egressProxy.headerSecret`)",
      keyIds: keys.egressHeaderKeyIds,
      team: kidCount(sql`${teamEgress.headersSealed}`, sql`${teamEgress}`),
    });
  }
  return families;
}

async function kids(tx: KobeDb | KobeTx, query: SQL, into: Map<string, number>): Promise<void> {
  const res = await tx.execute<{ kid: string; n: number }>(query);
  for (const row of res.rows) into.set(row.kid, (into.get(row.kid) ?? 0) + Number(row.n));
}

/** Reads each family's key ids (site tables once, team tables per team) and logs what is lost. */
export async function checkSealedKeys(
  db: KobeDb,
  families: readonly SealedFamily[],
  logger: Logger,
): Promise<SealedFinding[]> {
  const found = families.map(() => new Map<string, number>());
  for (const [i, f] of families.entries()) {
    if (f.site) await kids(db, f.site, found[i] as Map<string, number>);
  }
  if (families.some((f) => f.team)) {
    await scanTeams(db, "sealed key check", async (tx) => {
      for (const [i, f] of families.entries()) {
        if (f.team) await kids(tx, f.team, found[i] as Map<string, number>);
      }
      return undefined;
    });
  }
  const findings: SealedFinding[] = [];
  for (const [i, f] of families.entries()) {
    const lost = unknownKeys(found[i] as KidRows, f.keyIds);
    if (lost.rows === 0) continue;
    findings.push({ name: f.name, secret: f.secret, ...lost });
    logger.error(
      { sealed: f.name, rows: lost.rows, unknownKeyIds: lost.unknownKeyIds },
      `${lost.rows} stored ${f.name} were sealed with a key this server does not hold, so they ` +
        `cannot be opened: ${f.secret} is not the one they were written with (a restore with ` +
        "other Secrets? Put the original Secret back: docs/backup-restore.md, Secrets)",
    );
  }
  return findings;
}
