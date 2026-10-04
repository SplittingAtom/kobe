"use client";

import { forwardRef, type ComponentPropsWithRef } from "react";
import { Slot } from "radix-ui";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../ui/tooltip";

export type TooltipIconButtonProps = ComponentPropsWithRef<typeof Button> & {
  /** Shown as the tooltip and, for screen readers, as the button's accessible name. */
  readonly tooltip: string;
  readonly side?: "top" | "bottom" | "left" | "right";
};

/** assistant-ui's icon button: a ghost shadcn button with a tooltip (registry: tooltip-icon-button). */
export const TooltipIconButton = forwardRef<HTMLButtonElement, TooltipIconButtonProps>(
  ({ children, tooltip, side = "bottom", className, ...rest }, ref) => (
    <TooltipProvider delayDuration={0}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            {...rest}
            className={cn("aui-button-icon size-6 p-1 active:scale-90", className)}
            ref={ref}
          >
            <Slot.Slottable>{children}</Slot.Slottable>
            <span className="sr-only">{tooltip}</span>
          </Button>
        </TooltipTrigger>
        <TooltipContent side={side}>{tooltip}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  ),
);

TooltipIconButton.displayName = "TooltipIconButton";
