import type { SemanticMemoryWarningCode } from "@kobe/protocol";
import { PROSE_RULES } from "@kobe/skill-scanner";
import { extractLinkHosts } from "./links.js";
import { lintViews } from "./text.js";

/**
 * Instruction lint (KOBE-379, SM18): a memory states something; it must not steer the agent.
 * Four rules, each a warning code. They run on every view of the text (lint views: normalised,
 * look-alikes folded, letter spacing joined, leetspeak read as letters, lower case), so the same
 * words written differently still match. All patterns are linear (bounded gaps).
 *
 * Scope handling is the caller's (checks.ts): a warning on personal items, an audited "save
 * anyway" on Workspace and Site items, never on Policy (Policy is the Site's own instruction).
 */

type LintCode = Extract<SemanticMemoryWarningCode, `instruction_${string}`>;

const AGENT = String.raw`(?:you|the (?:assistant|agent|model|ai|bot)|kobe|claude)`;
/** Where an imperative verb starts: a sentence or clause, or after "please", "always", "you should" */
const LEAD = String.raw`(?:^|[.!?;:,(]\s*|\b(?:please|always|first|then|and|or|to|must|should|will|can|could|never|just)\s+)`;

/** A verb asking to fetch, open or send something. */
const FETCH_VERB = new RegExp(
  String.raw`${LEAD}(?:fetch|visit|open|download|curl|wget|browse(?: to)?|go to|navigate to|load|retrieve|read|get|check|pull|install from|post to|upload to|send (?:\w+ ){0,3}to)\b`,
  "gu",
);
/** Characters after the verb where the link may start. */
const FETCH_REACH = 60;

/**
 * A fetch verb followed (on the same line, within reach) by a link, found by the link checks' own
 * extractor (any scheme spelling, `www.`, host + path, or a bare registrable name such as
 * `evil.de`: review L-4), so the lint and the link warning agree on what a link is.
 */
function asksToFetch(view: string): boolean {
  let verbs = 0;
  for (const m of view.matchAll(FETCH_VERB)) {
    const from = m.index + m[0].length;
    const tail = view.slice(from, from + FETCH_REACH + 64).split("\n", 1)[0] ?? "";
    if (extractLinkHosts(tail).length > 0) return true;
    if (++verbs >= 20) return false;
  }
  return false;
}

type Test = RegExp | ((view: string) => boolean);
const passes = (test: Test, view: string): boolean =>
  typeof test === "function" ? test(view) : test.test(view);

const RULES: readonly { readonly code: LintCode; readonly patterns: readonly Test[] }[] = [
  {
    code: "instruction_imperative",
    patterns: [
      ...PROSE_RULES.filter((r) => r.id !== "prerequisite-install").map((r) => r.pattern),
      new RegExp(
        String.raw`\b${AGENT}\s+(?:must|should|shall|will|need to|have to|are to|are required to|may not|must not|should not|cannot|can't|are not allowed to|are allowed to)\b`,
        "u",
      ),
      /\b(?:from now on|going forward|in every (?:run|conversation|chat|answer|reply|response)|regardless of (?:what|any|the)|no matter what)\b/u,
      /\b(?:ignore|disregard|forget|override|bypass)\b[^.\n]{0,40}?\b(?:instructions?|rules?|polic(?:y|ies)|guardrails?|restrictions?|guidelines?)\b/u,
      /\b(?:act as|pretend (?:to be|you are|that you)|you are now|role-?play as)\b/u,
    ],
  },
  {
    code: "instruction_tools",
    patterns: [
      /\bsystem[\s_-]?prompts?\b|\b(?:developer|system) (?:message|instructions?)\b/u,
      /\btool[\s_-]?calls?\b|\b(?:call|invoke|use|run|trigger)\s+(?:the\s+)?[\w.-]+\s+tool\b/u,
      /\b(?:skip|bypass|disable|turn off|auto-?|without|no need for|don't need|do not need|never ask for)\s*(?:the\s+|any\s+)?(?:approvals?|approve|confirmation|permission)\b/u,
      /\bapprove\s+(?:all|every|any)\b|\b(?:dangerous|yolo)\s+mode\b/u,
    ],
  },
  {
    code: "instruction_fetch",
    patterns: [asksToFetch],
  },
  {
    code: "instruction_egress",
    patterns: [
      /\b(?:add|put|include|append|whitelist|allowlist|unblock|enable|open|allow|permit|grant)\b[^\n]{0,60}?\b(?:to|on|in|into)\s+(?:the\s+)?(?:egress\s+|domain\s+|network\s+)?(?:allow[\s-]?list|white[\s-]?list|ceiling)\b/u,
      /\b(?:enable|turn on|open|allow|widen|expand|grant|unblock)\s+(?:\w+\s+){0,2}(?:egress|internet|network|outbound)\b/u,
      /\b(?:request|ask for|requests?)\s+(?:\w+\s+)?access\s+to\b/u,
      new RegExp(String.raw`${LEAD}(?:whitelist|allowlist|unblock)\s+\S+`, "u"),
      /\b(?:use|enable|add|connect(?: to)?|install|call|switch on|turn on)\s+(?:the\s+|a\s+|an\s+)?(?:[\w.-]+\s+){0,2}(?:connector|mcp(?:\s+server)?|integration)s?\b/u,
    ],
  },
];

/** The instruction-lint codes `text` triggers, in rule order (each at most once). */
export function lintInstructions(text: string): LintCode[] {
  const views = lintViews(text);
  return RULES.filter((rule) =>
    rule.patterns.some((p) => views.some((view) => passes(p, view))),
  ).map((rule) => rule.code);
}
