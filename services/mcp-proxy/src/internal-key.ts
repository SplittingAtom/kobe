import { timingSafeEqual } from "node:crypto";

/** The server's internal key as a bearer token, compared in constant time. */
export function keyMatches(authorization: string | undefined, expected: string): boolean {
  const presented = /^Bearer (.+)$/.exec(authorization ?? "")?.[1];
  if (presented === undefined) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
