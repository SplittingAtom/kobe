/**
 * The file-type allowlist (KOBE-312, spec SK32). A skill is text: instructions, references and
 * scripts run through an interpreter. Binary content is allowed only as plain assets (images,
 * fonts, PDFs, audio/video); compiled code, executables and nested archives are Block, whatever
 * their name says (magic bytes decide where they are known). So are hidden files larger than
 * {@link HIDDEN_FILE_MAX_BYTES} (somewhere to smuggle a payload past review).
 */
export type FileTypeRule =
  "compiled-code" | "executable" | "nested-archive" | "binary" | "oversized-hidden-file";

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

const startsWith = (bytes: Uint8Array, magic: readonly number[]) =>
  magic.every((b, i) => bytes[i] === b);

const ARCHIVE_MAGIC: readonly (readonly number[])[] = [
  [0x50, 0x4b, 0x03, 0x04], // zip (jar, whl, docx…)
  [0x50, 0x4b, 0x05, 0x06], // empty zip
  [0x1f, 0x8b], // gzip
  [0x42, 0x5a, 0x68], // bzip2
  [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00], // xz
  [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c], // 7z
  [0x52, 0x61, 0x72, 0x21], // rar
  [0x28, 0xb5, 0x2f, 0xfd], // zstd
];
const EXECUTABLE_MAGIC: readonly (readonly number[])[] = [
  [0x7f, 0x45, 0x4c, 0x46], // ELF
  [0x4d, 0x5a], // PE (MZ)
  [0xcf, 0xfa, 0xed, 0xfe], // Mach-O 64
  [0xce, 0xfa, 0xed, 0xfe], // Mach-O 32
  [0xca, 0xfe, 0xba, 0xbe], // Mach-O universal / Java class
  [0x00, 0x61, 0x73, 0x6d], // wasm
];
const isTar = (bytes: Uint8Array) =>
  bytes.length > 262 && String.fromCharCode(...bytes.subarray(257, 262)) === "ustar";

export function extensionOf(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

const isHidden = (path: string) => path.split("/").some((s) => s.startsWith("."));

/** The Block rule a file breaks by its type, or null when its type is allowed. */
export function fileTypeRule(
  path: string,
  bytes: Uint8Array,
  binary: boolean,
): FileTypeRule | null {
  const ext = extensionOf(path);
  if (
    ARCHIVE_EXTENSIONS.has(ext) ||
    ARCHIVE_MAGIC.some((m) => startsWith(bytes, m)) ||
    isTar(bytes)
  )
    return "nested-archive";
  if (COMPILED_EXTENSIONS.has(ext)) return "compiled-code";
  if (EXECUTABLE_MAGIC.some((m) => startsWith(bytes, m))) return "executable";
  if (isHidden(path) && bytes.length > HIDDEN_FILE_MAX_BYTES) return "oversized-hidden-file";
  if (!binary) return null;
  const asset = ASSET_MAGIC.find(([exts]) => exts.includes(ext));
  if (asset && startsWith(bytes, asset[1])) return null;
  return "binary";
}
