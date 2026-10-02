import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

export const MANIFEST_FORMAT = "kobe-backup/1";
export const MANIFEST_FILE = "manifest.json";
export const DATABASE_FILE = "database.dump";
export const OBJECTS_FILE = "objects.jsonl";

/** Same rule as @kobe/db's quoteIdent: plain lowercase identifiers only. */
const tableName = z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/, "invalid table name");
const sha256 = z.string().regex(/^[0-9a-f]{64}$/, "invalid sha256");
const count = z.number().int().nonnegative();

const fileRef = z.object({
  // Only the fixed file names: a manifest must never point outside its own directory.
  path: z.enum([DATABASE_FILE, OBJECTS_FILE]),
  sha256,
  bytes: count,
});

const manifestSchema = z
  .object({
    format: z.literal(MANIFEST_FORMAT),
    createdAt: z.iso.datetime(),
    postgres: z.object({ serverVersion: z.string().max(200), pgDumpVersion: z.string().max(200) }),
    /** drizzle.__drizzle_migrations at the time of the snapshot, oldest first. */
    migrations: z.array(z.object({ hash: sha256, createdAt: count })).min(1),
    /** Tables whose rows are in the dump, with their row counts in the dump's snapshot. */
    tables: z.array(z.object({ name: tableName, rows: count })),
    /** Tables present at backup time whose rows were deliberately left out. */
    excludedTables: z.array(z.object({ name: tableName, reason: z.string().max(500) })),
    files: z.object({ database: fileRef, objects: fileRef.nullable() }),
    objectStorage: z
      .object({
        endpoint: z.string().max(500),
        bucket: z.string().min(1).max(255),
        prefix: z.string().max(1024),
        objects: count,
        bytes: count,
      })
      .nullable(),
  })
  .superRefine((m, ctx) => {
    const names = [...m.tables, ...m.excludedTables].map((t) => t.name);
    const dupes = names.filter((n, i) => names.indexOf(n) !== i);
    if (dupes.length > 0) {
      ctx.addIssue({ code: "custom", message: `table listed more than once: ${dupes.join(", ")}` });
    }
    if ((m.objectStorage === null) !== (m.files.objects === null)) {
      ctx.addIssue({ code: "custom", message: "objectStorage and files.objects must agree" });
    }
  });

export type Manifest = z.infer<typeof manifestSchema>;
export type FileRef = z.infer<typeof fileRef>;

/** Parses and validates a manifest; a backup directory is untrusted input. */
export function parseManifest(text: string): Manifest {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("Invalid backup manifest: not JSON");
  }
  const parsed = manifestSchema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new Error(`Invalid backup manifest: ${issues.join("; ")}`);
  }
  return parsed.data;
}

export async function sha256File(path: string): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    const buf = chunk as Buffer;
    bytes += buf.length;
    hash.update(buf);
  }
  return { sha256: hash.digest("hex"), bytes };
}

/** Fails unless `dir/ref.path` has exactly the recorded size and checksum. */
export async function verifyFile(dir: string, ref: FileRef): Promise<void> {
  const actual = await sha256File(join(dir, ref.path));
  if (actual.sha256 !== ref.sha256 || actual.bytes !== ref.bytes) {
    throw new Error(
      `${ref.path} does not match the manifest checksum: the backup is corrupt or was modified`,
    );
  }
}
