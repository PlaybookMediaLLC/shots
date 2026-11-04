"use client";

import {
  CheckboxItem as DropdownMenuCheckboxItemPrimitive,
  Content as DropdownMenuContentPrimitive,
  Group as DropdownMenuGroupPrimitive,
  ItemIndicator as DropdownMenuItemIndicatorPrimitive,
  Item as DropdownMenuItemPrimitive,
  Label as DropdownMenuLabelPrimitive,
  Portal as DropdownMenuPortalPrimitive,
  RadioGroup as DropdownMenuRadioGroupPrimitive,
  RadioItem as DropdownMenuRadioItemPrimitive,
  Root as DropdownMenuRoot,
  Separator as DropdownMenuSeparatorPrimitive,
  SubContent as DropdownMenuSubContentPrimitive,
  Sub as DropdownMenuSubPrimitive,
  SubTrigger as DropdownMenuSubTriggerPrimitive,
  Trigger as DropdownMenuTriggerPrimitive,
} from "@radix-ui/react-dropdown-menu";
import { cva, type VariantProps } from "class-variance-authority";
import { CheckIcon as CheckIcon } from "@phosphor-icons/react/dist/ssr/Check"
import { CaretRightIcon as ChevronRightIcon } from "@phosphor-icons/react/dist/ssr/CaretRight";
import { type ComponentProps, useCallback, useState } from "react";

import { cn } from "../lib/utils";

export const dropdownMenuItemVariants = cva(
  cn(
    "outline-none relative flex cursor-pointer select-none items-center gap-2 rounded-md align-middle text-sm transition-colors data-disabled:pointer-events-none data-disabled:opacity-50",
    "[&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground",
    "text-accent-foreground hover:bg-accent focus:bg-accent focus:text-accent-foreground"
  ),
  {
    defaultVariants: {
      size: "default",
      variant: "default",
    },
    variants: {
      size: {
        default: "mx-1 h-[28px] w-[calc(100%-8px)] px-2.5",
        none: "",
      },
      variant: {
        default: "focus:bg-accent focus:text-accent-foreground",
        none: "",
      },
    },
  }
);

const dropdownMenuLabelVariants = cva(
  cn(
    "mt-1.5 mb-2 cursor-default select-none px-[14px] font-medium text-muted-foreground text-xs"
  ),
  {
    variants: {
      inset: {
        true: "pl-8",
      },
    },
  }
);

export function DropdownMenu(props: ComponentProps<typeof DropdownMenuRoot>) {
  return <DropdownMenuRoot {...props} />;
}

export function DropdownMenuTrigger(
  props: ComponentProps<typeof DropdownMenuTriggerPrimitive>
) {
  return <DropdownMenuTriggerPrimitive {...props} />;
}

export function DropdownMenuGroup(
  props: ComponentProps<typeof DropdownMenuGroupPrimitive>
) {
  return <DropdownMenuGroupPrimitive className="py-1.5" {...props} />;
}

export function DropdownMenuPortal(
  props: ComponentProps<typeof DropdownMenuPortalPrimitive>
) {
  return <DropdownMenuPortalPrimitive {...props} />;
}

export function DropdownMenuSub(
  props: ComponentProps<typeof DropdownMenuSubPrimitive>
) {
  return <DropdownMenuSubPrimitive {...props} />;
}

export function DropdownMenuRadioGroup(
  props: ComponentProps<typeof DropdownMenuRadioGroupPrimitive>
) {
  return <DropdownMenuRadioGroupPrimitive {...props} />;
}

export function DropdownMenuSubTrigger({
  children,
  className,
  inset,
  ...props
}: ComponentProps<typeof DropdownMenuSubTriggerPrimitive> & {
  inset?: boolean;
}) {
  return (
    <DropdownMenuSubTriggerPrimitive
      className={cn(
        "mx-1 flex cursor-default select-none items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-hidden focus:bg-accent data-[state=open]:bg-accent",
        "outline-none",
        "data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
        inset && "pl-8",
        className
      )}
      {...props}
    >
      {children}
      <ChevronRightIcon className="ml-auto" />
    </DropdownMenuSubTriggerPrimitive>
  );
}

export function DropdownMenuSubContent({
  className,
  ...props
}: ComponentProps<typeof DropdownMenuSubContentPrimitive>) {
  return (
    <DropdownMenuSubContentPrimitive
      className={cn(
        "data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 z-50 min-w-32 overflow-hidden rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-popover data-[state=closed]:animate-out data-[state=open]:animate-in",
        className
      )}
      {...props}
    />
  );
}

export function DropdownMenuContent({
  className,
  portal,
  ...props
}: ComponentProps<typeof DropdownMenuContentPrimitive> & {
  portal?: boolean;
}) {
  const content = (
    <DropdownMenuContentPrimitive
      className={cn(
        "outline-none z-50 min-w-32 max-w-[100vw] overflow-hidden rounded-xl border border-border bg-popover p-0 text-popover-foreground text-sm shadow-popover",
        "data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=closed]:animate-out data-[state=open]:animate-in",
        className
      )}
      sideOffset={4}
      {...props}
    />
  );

  if (portal) {
    return <DropdownMenuPortalPrimitive>{content}</DropdownMenuPortalPrimitive>;
  }

  return content;
}

export function DropdownMenuItem({
  className,
  ...props
}: ComponentProps<typeof DropdownMenuItemPrimitive> &
  VariantProps<typeof dropdownMenuItemVariants>) {
  return (
    <DropdownMenuItemPrimitive
      className={cn(dropdownMenuItemVariants(), className)}
      {...props}
    />
  );
}

export function DropdownMenuCheckboxItem({
  children,
  className,
  ...props
}: ComponentProps<typeof DropdownMenuCheckboxItemPrimitive>) {
  return (
    <DropdownMenuCheckboxItemPrimitive
      className={cn(
        "outline-none relative flex select-none items-center gap-2 rounded-md py-1.5 pr-8 pl-2 transition-colors focus:bg-accent focus:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:size-4",
        "mx-1 h-[28px] cursor-pointer px-2.5 data-[state=highlighted]:bg-accent data-[state=highlighted]:text-accent-foreground",
        className
      )}
      {...props}
    >
      <span className="absolute right-2 flex size-3.5 items-center justify-center">
        <DropdownMenuItemIndicatorPrimitive>
          <CheckIcon />
        </DropdownMenuItemIndicatorPrimitive>
      </span>
      {children}
    </DropdownMenuCheckboxItemPrimitive>
  );
}

export function DropdownMenuRadioItem({
  children,
  className,
  hideIcon,
  ...props
}: ComponentProps<typeof DropdownMenuRadioItemPrimitive> & {
  hideIcon?: boolean;
}) {
  return (
    <DropdownMenuRadioItemPrimitive
      className={cn(
        "outline-none relative flex select-none items-center rounded-md pr-2 pl-8 transition-colors focus:bg-accent focus:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-50",
        "mx-1 h-[28px] cursor-pointer gap-2 px-2.5 data-[state=highlighted]:bg-accent data-[state=highlighted]:text-accent-foreground [&_svg]:size-4",
        className
      )}
      {...props}
    >
      {!hideIcon && (
        <span className="absolute right-2 flex size-3.5 items-center justify-center">
          <DropdownMenuItemIndicatorPrimitive>
            <CheckIcon />
          </DropdownMenuItemIndicatorPrimitive>
        </span>
      )}
      {children}
    </DropdownMenuRadioItemPrimitive>
  );
}

export function DropdownMenuLabel({
  className,
  inset,
  ...props
}: ComponentProps<typeof DropdownMenuLabelPrimitive> & {
  inset?: boolean;
}) {
  return (
    <DropdownMenuLabelPrimitive
      className={cn(dropdownMenuLabelVariants({ inset }), className)}
      {...props}
    />
  );
}

export function DropdownMenuSeparator({
  className,
  ...props
}: ComponentProps<typeof DropdownMenuSeparatorPrimitive>) {
  return (
    <DropdownMenuSeparatorPrimitive
      className={cn("-mx-1 my-1 h-px bg-muted", className)}
      {...props}
    />
  );
}

export function DropdownMenuShortcut({
  className,
  ...props
}: ComponentProps<"span">) {
  return (
    <span
      className={cn("ml-auto text-xs tracking-widest opacity-60", className)}
      {...props}
    />
  );
}

export function useOpenState() {
  const [open, setOpen] = useState(false);

  const onOpenChange = useCallback(
    (_value = !open) => {
      setOpen(_value);
    },
    [open]
  );

  return {
    open,
    onOpenChange,
  };
}
