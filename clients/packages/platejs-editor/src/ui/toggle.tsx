"use client";

import { Root as ToggleRoot } from "@radix-ui/react-toggle";
import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";

import { cn } from "../lib/utils";

export const toggleVariants = cva(
  cn(
    "inline-flex items-center justify-center rounded-md font-medium text-sm ring-offset-background transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50",
    "[&_svg:not([data-icon])]:size-5"
  ),
  {
    defaultVariants: {
      size: "default",
      variant: "default",
    },
    variants: {
      size: {
        circle: "p-3",
        default: "h-10 px-3",
        lg: "h-11 px-5",
        sm: "h-9 px-2",
      },
      variant: {
        default:
          "bg-transparent hover:bg-muted hover:text-muted-foreground data-[state=on]:bg-accent data-[state=on]:text-accent-foreground",
        floating: "rounded-full bg-primary text-primary-foreground",
        outline:
          "border border-input bg-transparent hover:bg-accent hover:text-accent-foreground",
      },
    },
  }
);

export function Toggle({
  className,
  size,
  variant,
  ...props
}: React.ComponentProps<typeof ToggleRoot> &
  VariantProps<typeof toggleVariants>) {
  return (
    <ToggleRoot
      className={cn(toggleVariants({ size, variant }), className)}
      {...props}
    />
  );
}
