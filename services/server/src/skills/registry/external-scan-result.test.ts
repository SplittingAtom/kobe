import { describe, expect, it } from "vitest";
import {
  externalCautionFindings,
  parseScanLog,
  raisedVerdict,
  SCAN_MARKER,
} from "./external-scan-result.js";

/** KOBE-341 (SK32): the external scanner's line, and what it may do to a verdict. */
const at = { startedAt: "2026-10-19T10:00:00.000Z", finishedAt: "2026-10-19T10:01:00.000Z" };
const line = (r: object) => `noise\n${SCAN_MARKER}${JSON.stringify(r)}\n`;
const finding = (severity: string) => ({
  ruleId: "YARA_prompt_injection_generic",
  severity,
  category: "prompt_injection",
  title: "PROMPT INJECTION detected by YARA",
  file: "SKILL.md",
  line: 2,
});
const ok = (findings: object[]) =>
  line({ v: 1, scanner: "cisco-ai-skill-scanner", version: "2.2.1", findings });

describe("the result line", () => {
  it("keeps rule, severity, category, title, file and line; MEDIUM and up need acknowledging", () => {
    const r = parseScanLog(ok([finding("critical"), finding("low")]), at);
    expect(r).toMatchObject({
      status: "done",
      scanner: "cisco-ai-skill-scanner",
      version: "2.2.1",
    });
    if (r.status !== "done") throw new Error("not done");
    expect(r.findings).toEqual([
      {
        rule: "cisco:YARA_prompt_injection_generic",
        file: "SKILL.md",
        line: 2,
        severity: "caution",
        externalSeverity: "critical",
        category: "prompt_injection",
        title: "PROMPT INJECTION detected by YARA",
      },
      expect.objectContaining({ severity: "info", externalSeverity: "low" }),
    ]);
    expect(externalCautionFindings({ external: r })).toHaveLength(1);
  });

  it("is a failure without a line, with a malformed one, or when the scanner says so", () => {
    expect(parseScanLog("nothing here", at)).toMatchObject({
      status: "failed",
      reason: "no_result",
    });
    expect(parseScanLog(`${SCAN_MARKER}{not json`, at)).toMatchObject({ reason: "bad_result" });
    expect(parseScanLog(line({ v: 2, scanner: "x", version: "1" }), at)).toMatchObject({
      reason: "bad_result",
    });
    expect(
      parseScanLog(line({ v: 1, scanner: "x", version: "1", error: "bad_package" }), at),
    ).toMatchObject({ status: "failed", reason: "bad_package" });
  });
});

describe("the verdict (ac-3)", () => {
  it("raises Pass to Caution, never sets Block, leaves Caution and Block alone", () => {
    const raising = parseScanLog(ok([finding("high")]), at);
    const info = parseScanLog(ok([finding("info")]), at);
    expect(raisedVerdict("pass", raising)).toBe("caution");
    expect(raisedVerdict("pass", info)).toBe("pass");
    expect(raisedVerdict("caution", raising)).toBe("caution");
    expect(raisedVerdict("block", raising)).toBe("block");
    expect(raisedVerdict("pass", { status: "failed", reason: "x", finishedAt: "" })).toBe("pass");
  });
});
