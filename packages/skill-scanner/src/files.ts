/**
 * The file-type allowlist (KOBE-312, spec SK32). A skill is text: instructions, references and
 * scripts run through an interpreter. Binary content is allowed only as plain assets (images,
 * fonts, PDFs, audio/video); compiled code, executables and nested archives are Block, whatever
 * their name says (magic bytes decide where they are known). So are hidden files larger than
 * {@link HIDDEN_FILE_MAX_BYTES} (somewhere to smuggle a payload past review).
 */
export type FileTypeRule =
  | "compiled-code"
  | "executable"
  | "nested-archive"
  | "binary"
  | "oversized-hidden-file"
  /** An executable or archive inside another file, at any offset (polyglots, appended ELF). */
  | "embedded-binary";

export const HIDDEN_FILE_MAX_BYTES = 64 * 1024;

const COMPILED_EXTENSIONS = new Set([
  "pyc",
  "pyo",
  "pyd",
  "class",
  "jar",
  "so",
  "dll",
  "dylib",
  "exe",
  "o",
  "a",
  "lib",
  "obj",
  "wasm",
  "bin",
  "msi",
  "com",
  "elc",
  "beam",
  "node",
  "ko",
  "sys",
]);
const ARCHIVE_EXTENSIONS = new Set([
  "zip",
  "tar",
  "gz",
  "tgz",
  "bz2",
  "tbz",
  "xz",
  "txz",
  "7z",
  "rar",
  "zst",
  "lz",
  "lzma",
  "cab",
  "whl",
  "egg",
  "nupkg",
  "apk",
  "deb",
  "rpm",
  "dmg",
  "iso",
  "cpio",
  "pyz",
  "pex",
  "war",
  "ear",
  "aar",
  "xpi",
  "crx",
  "vsix",
  "appimage",
]);
/** Binary assets a skill may carry (the extension must agree with the content's magic bytes). */
const ASSET_MAGIC: ReadonlyArray<readonly [readonly string[], readonly number[]]> = [
  [["png"], [0x89, 0x50, 0x4e, 0x47]],
  [
    ["jpg", "jpeg"],
    [0xff, 0xd8, 0xff],
  ],
  [["gif"], [0x47, 0x49, 0x46, 0x38]],
  [
    ["webp", "wav", "avi"],
    [0x52, 0x49, 0x46, 0x46],
  ],
  [["pdf"], [0x25, 0x50, 0x44, 0x46]],
  [["ico"], [0x00, 0x00, 0x01, 0x00]],
  [["woff"], [0x77, 0x4f, 0x46, 0x46]],
  [["woff2"], [0x77, 0x4f, 0x46, 0x32]],
  [["ttf"], [0x00, 0x01, 0x00, 0x00]],
  [["otf"], [0x4f, 0x54, 0x54, 0x4f]],
  [["mp3"], [0x49, 0x44, 0x33]],
  [["ogg"], [0x4f, 0x67, 0x67, 0x53]],
];

const startsWith = (bytes: Uint8Array, magic: readonly number[], at = 0) =>
  magic.every((b, i) => bytes[at + i] === b);
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

/** Extensions of the binary assets a skill may carry. */
const ASSET_EXTENSIONS = new Set(ASSET_MAGIC.flatMap(([exts]) => exts));
export const isAssetExtension = (ext: string) => ASSET_EXTENSIONS.has(ext);

const ARCHIVE_MAGIC: readonly (readonly number[])[] = [
  [0x50, 0x4b, 0x03, 0x04], // zip (jar, whl, docx…)
  [0x50, 0x4b, 0x05, 0x06], // empty zip
  [0x1f, 0x8b], // gzip
  [0x42, 0x5a, 0x68], // bzip2
  [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00], // xz
  [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c], // 7z
  [0x52, 0x61, 0x72, 0x21], // rar
  [0x28, 0xb5, 0x2f, 0xfd], // zstd
  ascii("!<arch>\n"), // ar, deb
  [0x04, 0x22, 0x4d, 0x18], // lz4
  [0x1f, 0x9d], // compress (.Z)
];
/** Archive magics made of printable text: they count only in content that is binary (has NUL). */
const TEXT_LIKE_ARCHIVE_MAGIC: readonly (readonly number[])[] = [
  ascii("LZIP"),
  ascii("MSCF"), // cab
  ascii("070701"), // cpio newc
  ascii("070707"), // cpio odc
  ascii("xar!"),
  ascii("hsqs"), // squashfs
];
const EXECUTABLE_MAGIC: readonly (readonly number[])[] = [
  [0x7f, 0x45, 0x4c, 0x46], // ELF
  [0xcf, 0xfa, 0xed, 0xfe], // Mach-O 64
  [0xce, 0xfa, 0xed, 0xfe], // Mach-O 32
  [0xca, 0xfe, 0xba, 0xbe], // Mach-O universal / Java class
  [0x00, 0x61, 0x73, 0x6d], // wasm
];
const isTar = (bytes: Uint8Array) =>
  bytes.length > 262 && String.fromCharCode(...bytes.subarray(257, 262)) === "ustar";

/**
 * The lower-cased extension of a path, ignoring invisible format characters (a zero-width space in
 * `run.p\u200by` must not hide `.py`); empty when there is none (or only a leading dot).
 */
export function extensionOf(path: string): string {
  const visible = path.replace(/\p{Cf}/gu, "");
  const base = visible.slice(visible.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

const isHidden = (path: string) => path.split("/").some((s) => s.startsWith("."));

const u32le = (b: Uint8Array, at: number) =>
  ((b[at] ?? 0) | ((b[at + 1] ?? 0) << 8) | ((b[at + 2] ?? 0) << 16) | ((b[at + 3] ?? 0) << 24)) >>>
  0;
const PE_SIGNATURE = [0x50, 0x45, 0x00, 0x00];
const MAX_PE_HEADER_OFFSET = 0x1000;

/** A PE executable at `at`: "MZ" whose e_lfanew points at a "PE\0\0" signature. */
function isPeAt(bytes: Uint8Array, at: number): boolean {
  if (bytes[at] !== 0x4d || bytes[at + 1] !== 0x5a) return false;
  const lfanew = u32le(bytes, at + 0x3c);
  return (
    lfanew >= 0x40 && lfanew < MAX_PE_HEADER_OFFSET && startsWith(bytes, PE_SIGNATURE, at + lfanew)
  );
}

/** An executable or zip header that starts at `at` (checked beyond offset 0 too). */
function binaryHeaderAt(bytes: Uint8Array, at: number): boolean {
  switch (bytes[at]) {
    case 0x50: // zip local file header or end of central directory
      return (
        bytes[at + 1] === 0x4b &&
        ((bytes[at + 2] === 0x03 && bytes[at + 3] === 0x04) ||
          (bytes[at + 2] === 0x05 && bytes[at + 3] === 0x06))
      );
    case 0x7f: // ELF, with a valid class byte
      return (
        startsWith(bytes, [0x7f, 0x45, 0x4c, 0x46], at) &&
        (bytes[at + 4] === 1 || bytes[at + 4] === 2)
      );
    case 0x4d:
      return isPeAt(bytes, at);
    case 0xcf:
    case 0xce: // Mach-O
      return startsWith(bytes, [0xfa, 0xed, 0xfe], at + 1);
    case 0xca: // Mach-O universal, Java class
      return startsWith(bytes, [0xfe, 0xba, 0xbe], at + 1);
    default:
      return false;
  }
}

/** Whether an executable or archive is hidden somewhere inside the content, past its start. */
function hasEmbeddedBinary(bytes: Uint8Array): boolean {
  for (let i = 1; i + 4 <= bytes.length; i++) if (binaryHeaderAt(bytes, i)) return true;
  return false;
}

/**
 * The Block rule a file breaks by its type, or null when its type is allowed. `binary`: the
 * content holds a NUL byte anywhere. Magic bytes are checked at the start, and executables and
 * zips at every offset (a polyglot asset or text with a payload appended).
 */
export function fileTypeRule(
  path: string,
  bytes: Uint8Array,
  binary: boolean,
): FileTypeRule | null {
  const ext = extensionOf(path);
  if (
    ARCHIVE_EXTENSIONS.has(ext) ||
    ARCHIVE_MAGIC.some((m) => startsWith(bytes, m)) ||
    (binary && TEXT_LIKE_ARCHIVE_MAGIC.some((m) => startsWith(bytes, m))) ||
    isTar(bytes)
  )
    return "nested-archive";
  if (COMPILED_EXTENSIONS.has(ext)) return "compiled-code";
  if (EXECUTABLE_MAGIC.some((m) => startsWith(bytes, m)) || isPeAt(bytes, 0)) return "executable";
  if (isHidden(path) && bytes.length > HIDDEN_FILE_MAX_BYTES) return "oversized-hidden-file";
  if (binary) {
    const asset = ASSET_MAGIC.find(([exts]) => exts.includes(ext));
    if (!asset || !startsWith(bytes, asset[1])) return "binary";
  }
  return hasEmbeddedBinary(bytes) ? "embedded-binary" : null;
}
