import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { EICAR, startFakeClamd, type FakeClamd } from "../testing/fake-clamd.js";
import { MemoryObjects } from "../testing/memory-objects.js";
import { createClamdScanner, scanStream } from "./clamd.js";

let clamd: FakeClamd | undefined;
afterEach(async () => {
  await clamd?.close();
  clamd = undefined;
});

const opts = (port: number) => ({ host: "127.0.0.1", port, timeoutMs: 300 });

describe("scanStream (clamd INSTREAM)", () => {
  it("says clean for ordinary bytes, also across many chunks", async () => {
    clamd = await startFakeClamd();
    const chunks = Array.from({ length: 50 }, (_, i) => Buffer.alloc(10_000, i));
    expect(await scanStream(opts(clamd.port), Readable.from(chunks))).toEqual({ result: "clean" });
  });

  it("says infected for EICAR, even split across chunks, with the signature name", async () => {
    clamd = await startFakeClamd();
    const half = Math.floor(EICAR.length / 2);
    const body = Readable.from([Buffer.from(EICAR.slice(0, half)), Buffer.from(EICAR.slice(half))]);
    expect(await scanStream(opts(clamd.port), body)).toEqual({
      result: "infected",
      signature: "Eicar-Test-Signature",
    });
  });

  it("is unavailable when nothing listens", async () => {
    const dead = await startFakeClamd();
    const { port } = dead;
    await dead.close();
    expect(await scanStream(opts(port), Readable.from([Buffer.from("x")]))).toMatchObject({
      result: "unavailable",
    });
  });

  it("is unavailable on a clamd ERROR, on gibberish and on a hang (fail closed)", async () => {
    for (const mode of ["error", "garbage", "hang"] as const) {
      clamd = await startFakeClamd(mode);
      const r = await scanStream(opts(clamd.port), Readable.from([Buffer.from("abc")]));
      expect(r.result, mode).toBe("unavailable");
      await clamd.close();
    }
    clamd = undefined;
  });

  it("is unavailable when the source stream breaks", async () => {
    clamd = await startFakeClamd();
    const broken = new Readable({
      read() {
        this.destroy(new Error("s3 went away"));
      },
    });
    expect((await scanStream(opts(clamd.port), broken)).result).toBe("unavailable");
  });
});

describe("createClamdScanner", () => {
  it("scans the stored object and maps the outcome", async () => {
    clamd = await startFakeClamd();
    const objects = new MemoryObjects();
    await objects.put("k/clean", Readable.from([Buffer.from("hello")]), 5);
    await objects.put("k/bad", Readable.from([Buffer.from(EICAR)]), EICAR.length);
    const scan = createClamdScanner(opts(clamd.port), objects);
    const at = (key: string) => scan({ key, size: 0, sha256: "" });
    expect(await at("k/clean")).toBe("clean");
    expect(await at("k/bad")).toBe("rejected");
    expect(await at("k/missing")).toBe("unavailable");
  });
});
