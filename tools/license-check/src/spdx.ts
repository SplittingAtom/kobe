/**
 * Minimal SPDX license-expression parser (operators case-insensitive, AND binds tighter than OR):
 *   or   := and (OR and)*
 *   and  := atom (AND atom)*
 *   atom := "(" or ")" | id [WITH exceptionId]
 * Any malformed input throws, so callers can fail closed.
 */
export type SpdxNode =
  | { readonly kind: "license"; readonly id: string; readonly exception?: string }
  | { readonly kind: "and" | "or"; readonly left: SpdxNode; readonly right: SpdxNode };

const OPERATORS = new Set(["AND", "OR", "WITH"]);

function tokenize(expression: string): string[] {
  return expression
    .replace(/[()]/g, " $& ")
    .trim()
    .split(/\s+/)
    .filter((t) => t !== "")
    .map((t) => (OPERATORS.has(t.toUpperCase()) ? t.toUpperCase() : t));
}

export function parseSpdx(expression: string): SpdxNode {
  const tokens = tokenize(expression);
  let pos = 0;

  const peek = (): string | undefined => tokens[pos];
  const next = (): string => {
    const token = tokens[pos++];
    if (token === undefined)
      throw new Error(`Unexpected end of license expression "${expression}"`);
    return token;
  };
  const isIdentifier = (t: string): boolean => t !== "(" && t !== ")" && !OPERATORS.has(t);

  function parseAtom(): SpdxNode {
    const token = next();
    if (token === "(") {
      const inner = parseOr();
      if (next() !== ")") throw new Error(`Expected ")" in "${expression}"`);
      return inner;
    }
    if (!isIdentifier(token)) throw new Error(`Unexpected "${token}" in "${expression}"`);
    if (peek() === "WITH") {
      next();
      const exception = next();
      if (!isIdentifier(exception)) throw new Error(`Bad WITH exception in "${expression}"`);
      return { kind: "license", id: token, exception };
    }
    return { kind: "license", id: token };
  }

  function parseAnd(): SpdxNode {
    let node = parseAtom();
    while (peek() === "AND") {
      next();
      node = { kind: "and", left: node, right: parseAtom() };
    }
    return node;
  }

  function parseOr(): SpdxNode {
    let node = parseAnd();
    while (peek() === "OR") {
      next();
      node = { kind: "or", left: node, right: parseAnd() };
    }
    return node;
  }

  const tree = parseOr();
  if (pos !== tokens.length) throw new Error(`Unexpected "${tokens[pos]}" in "${expression}"`);
  return tree;
}
