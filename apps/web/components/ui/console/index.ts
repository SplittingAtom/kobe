/**
 * Console primitives (KOBE-294): Tailwind and the theme tokens (app/tailwind.css, app/theme.css),
 * shared by the Site console, the Team console and the My area. Every page there is built on
 * them (KOBE-294..296): no CSS modules, which app/console-css-guard.test.ts enforces.
 *
 * Rules for a page:
 * - Layout and spacing with utilities on the console palette (`console-*`, `status-*`); no CSS
 *   module, no inline styles. A new shared pattern becomes a primitive here, with a test.
 * - Confirmations through `useConfirm()` with the asking control as the trigger; after a row is
 *   removed, keep focus on the list (components/admin/use-focus-after-removal.ts).
 * - Focus rings, colours and borders come from the primitives and the tokens, never from the
 *   console base rules in app/admin/admin-global.css (those serve plain content links only).
 */
export { Badge, type BadgeTone } from "./badge";
export { Button, buttonVariants, type ButtonVariant } from "./button";
export {
  ConfirmDialog,
  eventTrigger,
  useConfirm,
  type Confirm,
  type ConfirmOptions,
} from "./confirm-dialog";
export { EmptyState } from "./empty-state";
export { Field, FieldError, FormRow, RequiredMark, useFieldControl } from "./field";
export { FOCUS_RING } from "./focus";
export { Checkbox, ChoiceGroup, Radio, Select, Switch, Textarea, TextInput } from "./inputs";
export { ConsoleLayout, ConsoleMain, ConsoleWho } from "./layout";
export { Notice, type NoticeTone } from "./notice";
export { EmbeddedPage, PageHeader } from "./page-header";
export { RowMenu, type RowMenuItem } from "./row-menu";
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
