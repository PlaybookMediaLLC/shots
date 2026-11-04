"use client";

import {
  Button as ToolbarButtonPrimitive,
  Link as ToolbarLinkPrimitive,
  Root as ToolbarRoot,
  Separator as ToolbarSeparatorPrimitive,
  ToolbarToggleGroup as ToolbarToggleGroupPrimitive,
  ToolbarToggleItem as ToolbarToggleItemPrimitive,
} from "@radix-ui/react-toolbar";
import { cva, type VariantProps } from "class-variance-authority";
import { CaretDownIcon as ChevronDownIcon } from "@phosphor-icons/react/dist/ssr/CaretDown";
import type * as React from "react";
import { Children } from "react";

import { cn } from "../lib/utils";

import { Separator } from "./separator";
import { withTooltip } from "./tooltip";

const toolbarVariants = cva("relative flex select-none items-center", {
  defaultVariants: {
    variant: "default",
  },
  variants: {
    variant: {
      default: "gap-1 bg-background",
      media:
        "absolute z-2 h-[26px] max-w-[calc(100%-16px)] overflow-hidden rounded-md bg-black/60 transition-opacity",
    },
  },
});

export function Toolbar({
  className,
  variant,
  ...props
}: React.ComponentProps<typeof ToolbarRoot> &
  VariantProps<typeof toolbarVariants>) {
  return (
    <ToolbarRoot
      className={cn(toolbarVariants({ variant }), className)}
      {...props}
    />
  );
}

export function ToolbarToggleGroup({
  className,
  ...props
}: React.ComponentProps<typeof ToolbarToggleGroupPrimitive>) {
  return (
    <ToolbarToggleGroupPrimitive
      className={cn("flex items-center", className)}
      {...props}
    />
  );
}

export function ToolbarLink({
  className,
  ...props
}: React.ComponentProps<typeof ToolbarLinkPrimitive>) {
  return (
    <ToolbarLinkPrimitive
      className={cn("font-medium underline underline-offset-4", className)}
      {...props}
    />
  );
}

export function ToolbarSeparator({
  className,
  ...props
}: React.ComponentProps<typeof ToolbarSeparatorPrimitive>) {
  return (
    <ToolbarSeparatorPrimitive
      className={cn("mx-2 my-1 w-px shrink-0 bg-border", className)}
      {...props}
    />
  );
}

export const toolbarButtonVariants = cva(
  "inline-flex items-center justify-center gap-1 whitespace-nowrap rounded-md font-medium text-muted-foreground text-ui hover:text-foreground aria-checked:text-foreground ring-offset-background transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 [&_svg:not([data-icon])]:size-4",
  {
    defaultVariants: {
      size: "sm",
      variant: "default",
    },
    variants: {
      size: {
        // One control height with the app's Button (32px, as platform-shell.css sets it).
        default: "h-8 min-w-8 px-2",
        lg: "h-8 min-w-8 px-3",
        none: "",
        sm: "h-8 min-w-8 px-2",
      },
      variant: {
        default:
          "bg-transparent hover:bg-accent aria-checked:bg-accent aria-checked:text-accent-foreground",
        media:
          "outline-none m-0 h-auto rounded-md not-last:border-r not-last:border-r-white/20 bg-black/20 px-1.5 py-1 text-white hover:bg-background/5 focus:bg-background/5 [&_svg]:size-[14px] [&_svg]:text-white",
        outline:
          "border border-input bg-transparent hover:bg-accent hover:text-accent-foreground",
      },
    },
  }
);

export const ToolbarButton = withTooltip(function ToolbarButtonComponent({
  children,
  className,
  isDropdown,
  pressed,
  size,
  variant,
  ...props
}: Omit<
  React.ComponentProps<typeof ToolbarToggleItemPrimitive>,
  "asChild" | "value"
> & {
  isDropdown?: boolean;
  pressed?: boolean;
} & VariantProps<typeof toolbarButtonVariants>) {
  return typeof pressed === "boolean" ? (
    <ToolbarToggleGroupPrimitive
      disabled={props.disabled}
      type="single"
      value="single"
    >
      <ToolbarToggleItemPrimitive
        className={cn(
          toolbarButtonVariants({
            size,
            variant,
          }),
          isDropdown && "justify-between gap-0.5 pr-1",
          className
        )}
        value={pressed ? "single" : ""}
        {...props}
      >
        {isDropdown ? (
          <>
            <div className="flex flex-1 items-center gap-1 whitespace-nowrap">
              {children}
            </div>
            <div>
              <ChevronDownIcon
                className="size-3.5 text-muted-foreground/70"
                data-icon
              />
            </div>
          </>
        ) : (
          children
        )}
      </ToolbarToggleItemPrimitive>
    </ToolbarToggleGroupPrimitive>
  ) : (
    <ToolbarButtonPrimitive
      className={cn(
        toolbarButtonVariants({
          size,
          variant,
        }),
        isDropdown && "pr-1",
        className
      )}
      {...props}
    >
      {children}
    </ToolbarButtonPrimitive>
  );
});

export function ToolbarToggleItem({
  className,
  size,
  variant,
  ...props
}: React.ComponentProps<typeof ToolbarToggleItemPrimitive> &
  VariantProps<typeof toolbarButtonVariants>) {
  return (
    <ToolbarToggleItemPrimitive
      className={cn(toolbarButtonVariants({ size, variant }), className)}
      {...props}
    />
  );
}

export function ToolbarGroup({
  children,
  className,
}: React.ComponentProps<"div">) {
  const childArr = Children.map(children, (child) => child);

  if (!childArr || childArr.length === 0) return null;

  return (
    <div
      className={cn("group/toolbar-group relative flex shrink-0", className)}
    >
      <div className="flex items-center gap-0.5">{children}</div>

      <div className="group-last/toolbar-group:hidden! mx-1.5 hidden py-0.5 group-has-[button]/toolbar-group:block">
        <Separator orientation="vertical" />
      </div>
    </div>
  );
}
