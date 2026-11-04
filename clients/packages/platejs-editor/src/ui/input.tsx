"use client";

import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";

import { cn } from "../lib/utils";

export const inputVariants = cva(
  cn(
    "flex w-full rounded-md text-base outline-hidden file:border-0 file:bg-transparent file:font-medium file:text-sm disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
    "h-[28px] border-[1.5px] border-input bg-muted/80 px-1.5 placeholder:text-muted-foreground/80 dark:bg-transparent",
    "read-only:ring-0 read-only:focus:border-input"
  ),
  {
    defaultVariants: {
      variant: "default",
    },
    variants: {
      variant: {
        default: "focus:border-primary/50 focus:ring-2 focus:ring-primary/30",
        flat: "",
        link: "border-none bg-transparent shadow-none outline-hidden ring-0 focus:border-0 focus:border-transparent focus:outline-hidden focus:ring-0 focus:ring-offset-0 focus-visible:ring-0 focus-visible:ring-offset-0",
        search: "border-none bg-transparent text-lg",
      },
    },
  }
);

export type InputProps = React.ComponentProps<"input"> &
  VariantProps<typeof inputVariants>;

export function Input({ className, variant, ...props }: InputProps) {
  return (
    <input className={cn(inputVariants({ variant }), className)} {...props} />
  );
}
