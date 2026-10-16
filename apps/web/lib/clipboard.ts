/**
 * Copies text to the clipboard, also text still on its way (a conversation being read, KOBE-292).
 * Safari writes only during the click, so pending text goes as a `ClipboardItem` holding the
 * promise; where that is missing or refused, the text is written once it arrives.
 */
export async function copyText(text: string | Promise<string>): Promise<void> {
  const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
  if (!clipboard) throw new Error("The clipboard is not available here.");
  if (typeof text === "string") return clipboard.writeText(text);
  if (typeof ClipboardItem !== "undefined" && typeof clipboard.write === "function") {
    const blob = text.then((t) => new Blob([t], { type: "text/plain" }));
    try {
      await clipboard.write([new ClipboardItem({ "text/plain": blob })]);
      return;
    } catch {
      // Promised items unsupported, or the write refused: write the text once it is here.
    }
  }
  return clipboard.writeText(await text);
}
