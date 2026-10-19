import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  Envelope,
  PROVIDER_KEY_PURPOSE,
  SecretBox,
  VIRTUAL_KEY_PURPOSE,
  connectorSiteKeys,
  connectors,
  modelGatewayKeys,
  modelProviders,
  providerKeyContext,
  virtualKeyContext,
  withTeam,
} from "@kobe/db";
import pino from "pino";
import { siteKeyContext, urlSha256 } from "./connectors/site-key.js";
import { checkSealedKeys, sealedFamilies, unknownKeys } from "./startup/sealed-keys.js";
import { EventStreamFixture } from "./testing/event-stream-fixture.js";

/**
 * KOBE-425: a site restored with other Secrets holds sealed values no key of the server opens.
 * The start-up check names each such family with the Secret to put back, and says nothing when the
 * keys are the ones the values were sealed with.
 */
const SOURCE = { provider: "p".repeat(40), virtual: "v".repeat(40), envelope: "e".repeat(40) };
const OTHER = { provider: "q".repeat(40), virtual: "w".repeat(40), envelope: "f".repeat(40) };
const keysOf = (k: typeof SOURCE) => ({
  providerKeyIds: new SecretBox(k.provider, PROVIDER_KEY_PURPOSE).keyIds,
  virtualKeyIds: new SecretBox(k.virtual, VIRTUAL_KEY_PURPOSE).keyIds,
  envelopeKeyIds: new Envelope(k.envelope).keyIds,
});

function capture() {
  const lines: Record<string, unknown>[] = [];
  const logger = pino(
    { level: "error" },
    { write: (s: string) => void lines.push(JSON.parse(s) as Record<string, unknown>) },
  );
  return { logger, lines };
}

const f = new EventStreamFixture();
let teamId: string;

beforeAll(async () => {
  await f.setup([{}]);
  const ann = await f.person("ann");
  teamId = await f.team(`sealed-${Date.now()}`, ann);
  await f.db.insert(modelProviders).values({
    id: "sealed-test",
    kind: "openai_compatible",
    name: "Sealed test",
    baseUrl: "http://sealed.invalid",
    apiKeyEnc: new SecretBox(SOURCE.provider, PROVIDER_KEY_PURPOSE).seal(
      "sk-test",
      providerKeyContext("sealed-test", 1),
    ),
    keyRevision: 1,
    createdBy: ann.id,
  });
  // A connector's site-wide key (KOBE-303) is checked like the other envelope-sealed values.
  const [connector] = await f.db
    .insert(connectors)
    .values({
      name: `sealed-${Date.now()}`,
      url: "https://sealed.invalid/mcp",
      authKind: "api_key",
      credentialSource: "site",
    })
    .returning({ id: connectors.id });
  const connectorId = (connector as { id: string }).id;
  const sealed = new Envelope(SOURCE.envelope).seal(
    "site-secret",
    siteKeyContext(connectorId, "https://sealed.invalid/mcp"),
  );
  await f.db.insert(connectorSiteKeys).values({
    connectorId,
    sealed,
    keyId: Envelope.keyIdOf(sealed),
    urlSha256: urlSha256("https://sealed.invalid/mcp"),
    hint: "••••",
  });
  await withTeam(f.db, teamId, (tx) =>
    tx.insert(modelGatewayKeys).values({
      teamId,
      userId: ann.id,
      vkId: "vk-1",
      vkValueEnc: new SecretBox(SOURCE.virtual, VIRTUAL_KEY_PURPOSE).seal(
        "vk-secret",
        virtualKeyContext(teamId, ann.id),
      ),
    }),
  );
});
afterAll(async () => {
  await f.teardown();
});

describe("the sealed key check at start (KOBE-425)", () => {
  it("is quiet when the server holds the keys the values were sealed with", async () => {
    const { logger, lines } = capture();
    expect(await checkSealedKeys(f.db, sealedFamilies(keysOf(SOURCE)), logger)).toEqual([]);
    expect(lines).toEqual([]);
  });

  it("names each family sealed with a key it does not hold, and the Secret to put back", async () => {
    const { logger, lines } = capture();
    const findings = await checkSealedKeys(f.db, sealedFamilies(keysOf(OTHER)), logger);
    expect(findings.map((x) => [x.name, x.rows])).toEqual([
      ["model provider API keys", 1],
      ["members' model gateway virtual keys", 1],
      ["connector site-wide keys", 1],
    ]);
    expect(findings[0]?.secret).toContain("provider-keys");
    expect(findings[1]?.secret).toContain("virtual-keys");
    expect(lines).toHaveLength(3);
    expect(findings[2]?.secret).toContain("envelope");
    expect(String(lines[0]?.msg)).toContain("cannot be opened");
    expect(String(lines[0]?.msg)).toContain("docs/backup-restore.md");
    // Nothing secret in the log: key ids are derived and public, values never read.
    expect(JSON.stringify(lines)).not.toContain("sk-test");
    expect(JSON.stringify(lines)).not.toContain(OTHER.provider);
    expect(JSON.stringify(lines)).not.toContain("site-secret");
  });

  it("accepts a previous key during a rotation (the value opens with it)", async () => {
    const rotated = {
      ...keysOf(OTHER),
      providerKeyIds: new SecretBox([OTHER.provider, SOURCE.provider], PROVIDER_KEY_PURPOSE).keyIds,
    };
    const findings = await checkSealedKeys(f.db, sealedFamilies(rotated), capture().logger);
    expect(findings.map((x) => x.name)).toEqual([
      "members' model gateway virtual keys",
      "connector site-wide keys",
    ]);
  });
});

describe("unknownKeys", () => {
  it("counts the rows under ids not held", () => {
    expect(
      unknownKeys(
        new Map([
          ["a", 2],
          ["b", 3],
          ["c", 1],
        ]),
        ["a"],
      ),
    ).toEqual({
      rows: 4,
      unknownKeyIds: ["b", "c"],
    });
    expect(unknownKeys(new Map(), ["a"])).toEqual({ rows: 0, unknownKeyIds: [] });
  });
});
