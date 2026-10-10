/** Hands downloaded bytes to the browser as a file named `name` (a plain link cannot send `X-Kobe-Team`). */
export function saveBytes(name: string, bytes: Uint8Array): void {
  const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)]));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}
