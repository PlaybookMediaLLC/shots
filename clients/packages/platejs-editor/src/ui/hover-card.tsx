"use client";

import {
  Content as HoverCardContentPrimitive,
  Portal as HoverCardPortal,
  Root as HoverCardRoot,
  Trigger as HoverCardTriggerPrimitive,
} from "@radix-ui/react-hover-card";
import type { ComponentProps } from "react";

import { cn } from "../lib/utils";

function HoverCard({ ...props }: ComponentProps<typeof HoverCardRoot>) {
  return <HoverCardRoot data-slot="hover-card" {...props} />;
}

function HoverCardTrigger({
  ...props
}: ComponentProps<typeof HoverCardTriggerPrimitive>) {
  return (
    <HoverCardTriggerPrimitive data-slot="hover-card-trigger" {...props} />
  );
}

function HoverCardContent({
  align = "center",
  className,
  sideOffset = 4,
  ...props
}: ComponentProps<typeof HoverCardContentPrimitive>) {
  return (
    <HoverCardPortal data-slot="hover-card-portal">
      <HoverCardContentPrimitive
        align={align}
        className={cn(
          "data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 z-50 w-64 rounded-md border bg-popover p-4 text-popover-foreground shadow-md outline-hidden data-[state=closed]:animate-out",
          className
        )}
        data-slot="hover-card-content"
        sideOffset={sideOffset}
        {...props}
      />
    </HoverCardPortal>
  );
}

export { HoverCard, HoverCardContent, HoverCardTrigger };
