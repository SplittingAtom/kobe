/**
 * Prose rules (KOBE-312, spec SK32), on every text file: instructions written to steer the model
 * against its user or its policy, invisible or bidi characters that hide text from a reviewer,
 * and "prerequisite" steps that install or fetch something before the skill is used. Caution:
 * a reviewer reads and acknowledges each one. All patterns are linear (bounded gaps).
 */
export interface ProseRule {
  readonly id: string;
  readonly pattern: RegExp;
}

export const PROSE_RULES: readonly ProseRule[] = [
  {
    id: "prompt-injection",
    pattern:
      /\b(?:ignore|disregard|forget|override)\s+(?:all\s+|any\s+)?(?:of\s+)?(?:the\s+|your\s+)?(?:previous|prior|above|earlier|system|original)\s+(?:instructions|prompts?|rules|guidelines|messages)\b|\bdisregard\s+the\s+system\s+prompt\b|\byou\s+are\s+now\s+(?:in\s+)?(?:developer|god|jailbreak|dan|unrestricted)\s*mode\b/i,
  },
  {
    id: "conceal-from-user",
    pattern:
      /\b(?:do\s+not|don't|never)\s+(?:tell|inform|notify|show|reveal\s+to|mention\s+to)\s+the\s+user\b|\bwithout\s+(?:telling|informing|asking)\s+the\s+user\b|\bkeep\s+this\s+(?:secret|hidden)\s+from\s+the\s+user\b/i,
  },
  {
    id: "exfiltration-request",
    pattern:
      /\b(?:send|post|upload|exfiltrate|forward|transmit)\s+(?:all\s+|any\s+)?(?:the\s+)?(?:\w+\s+){0,3}(?:credentials|secrets|api\s+keys?|tokens|passwords|private\s+keys?|env(?:ironment)?\s+variables)\b[^\n]{0,80}\b(?:to|at)\s+(?:https?:\/\/|[\w-]+\.[a-z]{2,})/i,
  },
  {
    id: "prerequisite-install",
    pattern:
      /\b(?:prerequisites?|before\s+(?:using|running|you\s+use)\s+this\s+skill|first,?\s+(?:run|install|execute))\b[^\n]{0,120}?\b(?:curl|wget|pip3?\s+install|npm\s+(?:install|i)\b|brew\s+install|apt(?:-get)?\s+install|bash\s+-c|\|\s*(?:ba)?sh\b|iex\b|powershell)/i,
  },
];

/** Zero-width, bidi-control and other invisible formatting characters. */
export const INVISIBLE = /[\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\u00ad\ufeff]/;
