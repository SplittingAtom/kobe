/**
 * Console primitives (KOBE-294): Tailwind and the theme tokens (app/tailwind.css, app/theme.css),
 * shared by the Site console, the Team console and the My area. Pages move to them in KOBE-295
 * and KOBE-296; the guard in app/console-css-guard.test.ts tracks which have.
 */
export { Badge, type BadgeTone } from "./badge";
export { Button, buttonVariants, type ButtonVariant } from "./button";
export { ConfirmDialog, useConfirm, type ConfirmOptions } from "./confirm-dialog";
export { EmptyState } from "./empty-state";
export { Field, FormRow, useFieldControl } from "./field";
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
