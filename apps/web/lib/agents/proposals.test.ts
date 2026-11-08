import { describe, expect, it } from "vitest";
import { row } from "../../components/agents/roster-fixtures";
import { proposalCount, shownRows } from "./proposals";

describe("proposals queue (KOBE-570, §6.4)", () => {
  const active = row({ agentId: "a" });
  const toDecide = row({ agentId: "b", status: "proposed", actions: { decide: true } });
  const ownProposal = row({ agentId: "c", status: "proposed" });

  it("counts the proposals the viewer decides, not their own pending ones", () => {
    expect(proposalCount([active, toDecide, ownProposal])).toBe(1);
    expect(proposalCount([])).toBe(0);
  });

  it("filters to those proposals, or shows every row", () => {
    expect(shownRows([active, toDecide, ownProposal], true)).toEqual([toDecide]);
    expect(shownRows([active, toDecide], false)).toEqual([active, toDecide]);
  });
});
