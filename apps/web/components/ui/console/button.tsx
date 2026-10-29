import { cva, type VariantProps } from "class-variance-authority";
import { LoaderCircleIcon } from "lucide-react";
import { Slot } from "radix-ui";
import type { ComponentProps } from "react";
import { cn } from "../../../lib/utils";
import { FOCUS_RING } from "./focus";

/**
 * Console buttons (KOBE-294), shadcn's pattern on the console palette. Secondary is the default
 * (most console actions); primary is the page's main action; danger is for removing, revoking and
 * leaving, outlined so its text keeps contrast in both themes; ghost is for quiet actions in
 * dense rows. No preflight on these pages, so the classes reset the browser's button look.
 * `asChild` styles a link as a button: `<Button asChild><Link href="…">New agent</Link></Button>`.
 */
export const buttonVariants = cva(
  `m-0 box-border inline-flex cursor-pointer items-center justify-center gap-1.5 rounded-md border font-[inherit] text-sm leading-5 font-medium whitespace-nowrap no-underline transition-colors disabled:cursor-not-allowed disabled:opacity-50 aria-busy:cursor-progress [&_svg]:size-4 [&_svg]:shrink-0 ${FOCUS_RING}`,
  {
    variants: {
      variant: {
        primary:
          "border-transparent bg-status-accent text-status-accent-fg hover:enabled:bg-brand-primary-hover",
        secondary:
          "border-console-control bg-console-bg text-console-fg hover:enabled:bg-console-panel",
        danger:
          "border-console-danger bg-console-bg text-console-danger hover:enabled:bg-console-danger-bg",
        ghost: "border-transparent bg-transparent text-console-fg hover:enabled:bg-console-panel",
      },
      size: {
        default: "min-h-8 px-3 py-1",
        sm: "min-h-7 px-2 py-0.5 text-xs",
      },
    },
    defaultVariants: { variant: "secondary", size: "default" },
  },
);

export type ButtonVariant = NonNullable<VariantProps<typeof buttonVariants>["variant"]>;

export function Button({
  className,
  variant,
  size,
  type = "button",
  loading = false,
  asChild = false,
  disabled,
  children,
  ...props
}: ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    /** The action is running: disabled, `aria-busy`, a spinner before the unchanged label. */
    readonly loading?: boolean;
    readonly asChild?: boolean;
  }) {
  const shared = {
    "data-slot": "console-button",
    "data-variant": variant ?? "secondary",
    className: cn(buttonVariants({ variant, size }), className),
  };
  if (asChild) {
    return (
      <Slot.Root {...shared} {...props}>
        {children}
      </Slot.Root>
    );
  }
  return (
    <button
      {...shared}
      type={type}
      disabled={disabled === true || loading}
      {...(loading ? { "aria-busy": true } : {})}
      {...props}
    >
      {loading && <LoaderCircleIcon aria-hidden className="animate-spin" />}
      {children}
    </button>
  );
}
