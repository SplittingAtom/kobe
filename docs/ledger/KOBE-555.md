# KOBE-555: Catalyst look: ship Outfit and JetBrains Mono (SIL OFL 1.1), allow OFL in the licence check

- **Status:** in review (PR #464)
- **Branch / worktree:** `kobe-555-catalyst-fonts` in `../Kobe-wt555`
- **Depends on:** KOBE-550 (Catalyst preset)

## Plan

1. Fetch the faces from the projects' own releases into a scratch directory, check them, convert
   the variable TTFs to WOFF2, copy into `apps/web/app/fonts/<face>/` with each `OFL.txt`.
2. `apps/web/app/faces.ts`: `next/font/local`, swap, CSS variables on `<html>` (root layout).
3. A fifth typeface key `catalyst` (protocol `FONT_STACKS`); `FONT_STACK_VALUES` /
   `MONO_STACK_VALUES` in `lib/theme/presets.ts`; branding CSS emits `--kobe-font-mono` too; the
   Catalyst preset uses `catalyst`.
4. Licence: `OFL-1.1` in `ALLOWED_LICENSES`, inventory section Fonts, `pnpm licenses:update`.
5. Docs: TH10 amended (spec record + theming §3/§5/§9), licensing policy sentence.

## Font provenance (files unmodified apart from TTF to WOFF2)

| File in `apps/web/app/fonts/`              | Source                                                                                                                                                                                                                                                                                                           | Version                                            | sha256                                                             |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------ |
| `outfit/Outfit[wght].woff2`                | converted from `https://raw.githubusercontent.com/Outfitio/Outfit-Fonts/1.1/fonts/variable/Outfit%5Bwght%5D.ttf` (TTF sha256 `1a15a7e5cc57376610613f6a2152b42a3c8c066948f9cb74e31a1b0d0bdc98ab`)                                                                                                                 | tag 1.1 (no release assets; repo files at the tag) | `a849b06db022227684c970ad3038f98ca9b91053798194d9999dfa9228a46f7a` |
| `outfit/OFL.txt`                           | `https://raw.githubusercontent.com/Outfitio/Outfit-Fonts/1.1/OFL.txt`                                                                                                                                                                                                                                            | 1.1                                                | `c676351bf8576b9aba743cd5eaa8c0e7ee0d51f805d720447b4df4ddb6a2e416` |
| `jetbrains-mono/JetBrainsMono[wght].woff2` | converted from `fonts/variable/JetBrainsMono[wght].ttf` in `https://github.com/JetBrains/JetBrainsMono/releases/download/v2.304/JetBrainsMono-2.304.zip` (zip sha256 `6f6376c6ed2960ea8a963cd7387ec9d76e3f629125bc33d1fdcd7eb7012f7bbf`, TTF `662a196d58f1183bf2d77428b6d5283fe3f45161ab021bea4036bc98e5cac016`) | v2.304                                             | `cf49510c0f056447d2d1a9c7ad19200568f4695f0f975953bbd43ecb1da1fd10` |
| `jetbrains-mono/OFL.txt`                   | `OFL.txt` in the same zip                                                                                                                                                                                                                                                                                        | v2.304                                             | `30f0c136e3c88e422d0791acd97238870f9054a9729bc34cf2ff0d4ed8cac4ad` |

Conversion: `pnpm dlx ttf2woff2@6.0.1 < in.ttf > out.woff2` (Google's woff2 encoder; lossless
container change), run once, no dependency added. Neither project publishes a variable WOFF2
(Outfit's and JetBrains Mono's `webfonts/` hold static weights only). Neither `OFL.txt` declares a
Reserved Font Name; names are kept anyway. The build copies the files byte for byte to
`/_next/static/media` (same sizes, 43,708 and 116,240 bytes).

## Decisions

- **Protocol:** `catalyst` is added to `FONT_STACKS` in this PR (an additive enum value; the brief
  requires a custom theme to be able to pick it). Older stored themes stay valid.
- **Variables, not family names:** a stack names `var(--kobe-face-outfit, Outfit)`; next/font
  generates the family name. The `var()` fallback keeps the face name if the class is missing.
- **No preload:** only Catalyst uses the faces, so other themes download no font.
- **Fallbacks (review):** Outfit has `adjustFontFallback: "Arial"` (metric-matched Arial, small
  CLS on swap). JetBrains Mono keeps `false`: next/font offers only Arial and Times New Roman,
  and a proportional fallback for code would be worse than the system mono stack.
- **`--kobe-font-mono`** is emitted by the branding CSS only for `catalyst` (review); other
  themes keep theme.css's value. The preview roots reset it to `SYSTEM_MONO_STACK`.
- **OFL allow is global** (Chris asked for "allow SIL Open Font License"): the check cannot scope a
  licence to fonts; policy comment and licensing.md say so.
- Appearance Typeface hint reworded: system stacks download nothing, Outfit ships two files.
- **Subsets:** `next/font/local` has no `subsets` option, and subsetting would modify the files.
  Both files cover Latin and Latin Extended-A (Outfit only Latin; JetBrains Mono also Greek,
  Cyrillic, Vietnamese); they ship whole.
- **Upright only:** the JetBrains Mono italic variable file is not shipped (browsers synthesise
  oblique for the rare italic code).
- **OFL in the image:** both `OFL.txt` files are also copied to `/usr/share/doc/kobe/fonts/` in the
  web image (the standalone output carries only the hashed WOFF2 files).
- Appearance preview gains a mono code sample so both faces show.

## Open questions (for Chris or the coordinator)

- Subset to latin + latin-ext (smaller JetBrains Mono, ~116 KB now) would need modified files;
  kept whole per "unmodified apart from format conversion".

## Evidence (acceptance criteria → test or command output)

- ac-1: `apps/web/app/faces.test.ts`, `app/layout.test.tsx` ("puts the face classes on <html>"),
  `app/theme-css.test.ts` ("fonts are self-hosted"); `lib/security/csp.ts` unchanged
  (`font-src 'self'`); web build emits `@font-face{...src:url(../media/Outfit[wght]...woff2)}`.
- ac-2: `lib/theme/presets.test.ts`, `branding-css.test.ts`, `preview-css.test.ts`,
  `components/admin/appearance-parts.test.tsx`.
- ac-3: `tools/license-check/src/policy.test.ts` ("allows OFL-1.1"), inventory Fonts section,
  `THIRD_PARTY_LICENSES.md` regenerated (NOTICE unchanged: no NOTICE files), `pnpm license:check` green.
- ac-4: `docs/specs/theming.md` TH10, `docs/theming.md` §3/§5/§9, `docs/licensing.md` Policy.
- ac-5: `pnpm verify` green; PR CI (see PR).
