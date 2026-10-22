/**
 * What stays in the composer once a message went (KOBE-415): the member may type on while it is
 * being sent. Text added after the sent text stays, without the sent part and the one space or
 * line break that joined them; text whose sent part was edited stays whole; the unchanged sent
 * text clears. The sent text never stays in the box.
 */
export function textAfterSend(current: string, sent: string): string {
  if (current === sent) return "";
  if (!current.startsWith(sent)) return current;
  const rest = current.slice(sent.length);
  return /^[ \n]/u.test(rest) ? rest.slice(1) : rest;
}
