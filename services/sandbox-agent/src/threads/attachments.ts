import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import type { SandboxAttachment } from "@kobe/protocol";

/**
 * Confinement of `run.start.attachments[].path` (KOBE-144). The server names paths, but the
 * workspace is writable by the model, so a path is only trusted after the filesystem agrees:
 *
 * 1. lexical: absolute, under the workspace root, no `..`, no control characters or backslashes;
 * 2. physical: `realpath` of the target (or of its deepest existing ancestor, when the file has not
 *    been synced yet) must equal `realpath(root)/rel`. A symlink in any component, to outside or
 *    elsewhere inside, changes the real path and is refused; a symlink as the last component is
 *    refused even when dangling;
 * 3. an existing target is a regular file (no FIFO, device, socket, directory).
 *
 * Same rule as `share_file`'s path check (KOBE-149, tools/share-path.ts); fold the two into one
 * helper once both are on main.
 */
export class AttachmentPathError extends Error {}

export interface ConfinedAttachment {
  readonly absolute: string;
  readonly exists: boolean;
  readonly size: number;
}

// eslint-disable-next-line no-control-regex
const FORBIDDEN = /[\u0000-\u001f\u007f\\]/u;

function lexical(root: string, input: string): string {
  if (input === "" || FORBIDDEN.test(input) || !path.isAbsolute(input)) {
    throw new AttachmentPathError("attachment path is not a plain absolute path");
  }
  if (input.split("/").includes("..")) throw new AttachmentPathError("attachment path has ..");
  const resolved = path.resolve(input);
  if (!resolved.startsWith(`${root}${path.sep}`)) {
    throw new AttachmentPathError("attachment outside the workspace");
  }
  return resolved;
}

async function physicalMatches(root: string, realRoot: string, target: string): Promise<boolean> {
  let probe = target;
  for (;;) {
    try {
      const real = await realpath(probe);
      return real === path.join(realRoot, path.relative(root, probe));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
      const parent = path.dirname(probe);
      if (parent === probe || !parent.startsWith(root)) return false;
      probe = parent;
    }
  }
}

export async function confineAttachment(
  workspaceDir: string,
  input: string,
): Promise<ConfinedAttachment> {
  const root = path.resolve(workspaceDir);
  const absolute = lexical(root, input);
  const realRoot = await realpath(root).catch(() => undefined);
  if (realRoot === undefined) throw new AttachmentPathError("workspace root is unavailable");
  const stat = await lstat(absolute).catch((error: NodeJS.ErrnoException) => error);
  if (stat instanceof Error) {
    if (stat.code !== "ENOENT" && stat.code !== "ENOTDIR") {
      throw new AttachmentPathError("attachment cannot be resolved");
    }
    if (!(await physicalMatches(root, realRoot, absolute))) {
      throw new AttachmentPathError("attachment goes through a symbolic link");
    }
    return { absolute, exists: false, size: 0 };
  }
  if (stat.isSymbolicLink()) throw new AttachmentPathError("attachment is a symbolic link");
  if (!(await physicalMatches(root, realRoot, absolute))) {
    throw new AttachmentPathError("attachment goes through a symbolic link");
  }
  if (!stat.isFile()) throw new AttachmentPathError("attachment is not a regular file");
  return { absolute, exists: true, size: stat.size };
}

/** Largest image handed to Pi inline (provider limits are around 5 MB per image). */
export const NATIVE_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const NATIVE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export interface PiImage {
  readonly type: "image";
  readonly data: string;
  readonly mimeType: string;
}

/**
 * The attachments' images for Pi's `prompt.images`: only those marked `native_media: "image"`, of a
 * type and size providers accept, already confined. Pi 1.0's RPC `prompt` has `images` only (no
 * document block), so `pdf` stays a path. Everything else is listed by path.
 */
export async function nativeImages(
  workspaceDir: string,
  attachments: readonly SandboxAttachment[],
): Promise<{ readonly images: readonly PiImage[]; readonly inlined: ReadonlySet<string> }> {
  const images: PiImage[] = [];
  const inlined = new Set<string>();
  for (const attachment of attachments) {
    if (attachment.native_media !== "image") continue;
    if (!NATIVE_IMAGE_TYPES.has(attachment.mime_type)) continue;
    const confined = await confineAttachment(workspaceDir, attachment.path);
    if (!confined.exists || confined.size > NATIVE_IMAGE_MAX_BYTES) continue;
    const data = (await readFile(confined.absolute)).toString("base64");
    images.push({ type: "image", data, mimeType: attachment.mime_type });
    inlined.add(attachment.path);
  }
  return { images, inlined };
}

/** The prompt text: the message plus the attached files, with a note for media not shown inline. */
export function promptWithAttachments(
  message: string,
  attachments: readonly SandboxAttachment[],
  inlined: ReadonlySet<string>,
): string {
  if (attachments.length === 0) return message;
  const lines = attachments.map((a) => {
    const media = a.mime_type.startsWith("image/") || a.mime_type === "application/pdf";
    const note = inlined.has(a.path)
      ? " - shown to you as an image"
      : media
        ? " - not shown inline; open it from this path"
        : "";
    return `- ${a.path} (${a.mime_type})${note}`;
  });
  return `${message}\n\nAttached files:\n${lines.join("\n")}`;
}
