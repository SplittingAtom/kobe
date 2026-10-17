/**
 * Console primitives (KOBE-294): Tailwind and the theme tokens (app/tailwind.css, app/theme.css),
 * shared by the Site console, the Team console and the My area. Pages move to them in KOBE-295
 * and KOBE-296; the guard in app/console-css-guard.test.ts tracks which have.
 *
 * Rules for moving a page:
 * - Move a file whole: a file that imports these primitives imports no CSS module (guarded).
 * - The consoles' CSS modules sit in the `kobe-legacy` cascade layer (app/theme.css), below the
 *   utilities, so a module rule that still reaches a primitive (a container's `.form label`)
 *   loses to the primitive's classes. Modules shared with the chat (components/memory,
 *   components/files) are unlayered and still win: don't nest primitives inside them.
 * - Focus rings, colours and borders come from the primitives and the tokens, never from the
 *   console base rules in app/admin/admin-global.css (those serve plain content links only).
 */
export { Badge, type BadgeTone } from "./badge";
export { Button, buttonVariants, type ButtonVariant } from "./button";
export { ConfirmDialog, useConfirm, type ConfirmOptions } from "./confirm-dialog";
export { EmptyState } from "./empty-state";
export { Field, FieldError, FormRow, RequiredMark, useFieldControl } from "./field";
export { FOCUS_RING } from "./focus";
export { Checkbox, ChoiceGroup, Radio, Select, Switch, Textarea, TextInput } from "./inputs";
export { ConsoleLayout, ConsoleMain, ConsoleWho } from "./layout";
export { Notice, type NoticeTone } from "./notice";
export { PageHeader } from "./page-header";
export { Card, Section } from "./section";
export { SideNav, SideNavGroup, SideNavLink } from "./side-nav";
export {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableRowHeader,
} from "./table";
