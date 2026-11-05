"use client";

import {
  Anchor as PopoverAnchorPrimitive,
  Content as PopoverContentPrimitive,
  Portal as PopoverPortal,
  Root as PopoverRoot,
  Trigger as PopoverTriggerPrimitive,
} from "@radix-ui/react-popover";
import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";

import { cn } from "../lib/utils";

const popoverVariants = cva(
  cn(
    "group/popover",
    "z-50 max-w-[calc(100vw-24px)] animate-in fade-in-0 zoom-in-95 motion-reduce:animate-none overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-popover outline-hidden"
  ),
  {
    defaultVariants: {
      variant: "default",
    },
    variants: {
      variant: {
        combobox: "",
        default: "w-72",
        equation: "w-[400px] rounded-md px-2.5 py-2",
        equationInline: "w-[400px] rounded-md px-2.5 py-2",
        media: "max-h-[70vh] min-w-[180px] rounded-md",
      },
    },
  }
);

function Popover({ ...props }: ComponentProps<typeof PopoverRoot>) {
  return <PopoverRoot data-slot="popover" {...props} />;
}

function PopoverTrigger({
  ...props
}: ComponentProps<typeof PopoverTriggerPrimitive>) {
  return <PopoverTriggerPrimitive data-slot="popover-trigger" {...props} />;
}

function PopoverAnchor({
  ...props
}: ComponentProps<typeof PopoverAnchorPrimitive>) {
  return <PopoverAnchorPrimitive data-slot="popover-anchor" {...props} />;
}

function PopoverContent({
  align = "center",
  className,
  sideOffset = 4,
  variant,
  ...props
}: ComponentProps<typeof PopoverContentPrimitive> &
  VariantProps<typeof popoverVariants>) {
  return (
    <PopoverPortal>
      <PopoverContentPrimitive
        align={align}
        className={cn(popoverVariants({ variant }), className)}
        data-slot="popover-content"
        sideOffset={sideOffset}
        {...props}
      />
    </PopoverPortal>
  );
}

export {
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverTrigger,
  popoverVariants,
};
