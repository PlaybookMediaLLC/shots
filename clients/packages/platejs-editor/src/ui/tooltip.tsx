"use client";

import {
  Content as TooltipContentPrimitive,
  Portal as TooltipPortalPrimitive,
  Provider as TooltipProviderPrimitive,
  Root as TooltipRoot,
  Trigger as TooltipTriggerPrimitive,
} from "@radix-ui/react-tooltip";
import type * as React from "react";
import { useMounted } from "../hooks/use-mounted";
import { cn } from "../lib/utils";

export function TooltipProvider({
  delayDuration = 200,
  disableHoverableContent = true,
  skipDelayDuration = 0,
  ...props
}: React.ComponentProps<typeof TooltipProviderPrimitive>) {
  return (
    <TooltipProviderPrimitive
      delayDuration={delayDuration}
      disableHoverableContent={disableHoverableContent}
      skipDelayDuration={skipDelayDuration}
      {...props}
    />
  );
}

export const Tooltip = TooltipRoot;

export const TooltipTrigger = TooltipTriggerPrimitive;

export const TooltipPortal = TooltipPortalPrimitive;

export function TooltipContent({
  className,
  sideOffset = 4,
  ...props
}: React.ComponentProps<typeof TooltipContentPrimitive>) {
  return (
    <TooltipContentPrimitive
      className={cn(
        "z-9999 overflow-hidden rounded-md bg-foreground px-3 py-1.5 text-background text-xs",
        className
      )}
      sideOffset={sideOffset}
      {...props}
    />
  );
}

export function TooltipTC({
  children,
  className,
  content,
  defaultOpen,
  delayDuration,
  disableHoverableContent,
  open,
  onOpenChange,
  ...props
}: {
  content: React.ReactNode;
} & React.ComponentProps<typeof TooltipContentPrimitive> &
  React.ComponentPropsWithoutRef<typeof TooltipRoot>) {
  const mounted = useMounted();

  if (!mounted) {
    return children;
  }

  return (
    <TooltipProvider>
      <Tooltip
        defaultOpen={defaultOpen}
        delayDuration={delayDuration}
        disableHoverableContent={disableHoverableContent}
        onOpenChange={onOpenChange}
        open={open}
      >
        <TooltipTrigger asChild>{children}</TooltipTrigger>

        <TooltipPortal>
          <TooltipContent className={className} {...props}>
            {content}
          </TooltipContent>
        </TooltipPortal>
      </Tooltip>
    </TooltipProvider>
  );
}

type TooltipProps<T extends React.ElementType> = {
  shortcut?: React.ReactNode;
  tooltip?: React.ReactNode;
  tooltipContentProps?: Omit<
    React.ComponentPropsWithoutRef<typeof TooltipContentPrimitive>,
    "children"
  >;
  tooltipProps?: Omit<
    React.ComponentPropsWithoutRef<typeof TooltipRoot>,
    "children"
  >;
  tooltipTriggerProps?: React.ComponentPropsWithoutRef<
    typeof TooltipTriggerPrimitive
  >;
} & React.ComponentProps<T>;

export function withTooltip<T extends React.ElementType>(Component: T) {
  return function ExtendComponent({
    shortcut,
    tooltip,
    tooltipContentProps,
    tooltipProps,
    tooltipTriggerProps,
    ...props
  }: TooltipProps<T>) {
    const isMounted = useMounted();

    const component = <Component {...(props as React.ComponentProps<T>)} />;

    if (tooltip && isMounted) {
      return (
        <TooltipProvider>
          <Tooltip {...tooltipProps}>
            <TooltipTrigger asChild {...tooltipTriggerProps}>
              {component}
            </TooltipTrigger>

            <TooltipPortal>
              <TooltipContent {...tooltipContentProps}>
                {tooltip}
                {shortcut && (
                  <div className="mt-px text-background/70">{shortcut}</div>
                )}
              </TooltipContent>
            </TooltipPortal>
          </Tooltip>
        </TooltipProvider>
      );
    }

    return component;
  };
}
