"use client";

import type { VariantProps } from "class-variance-authority";
import { cva } from "class-variance-authority";
import {
  PlateContainer,
  PlateContent,
  type PlateContentProps,
  useEditorRef,
} from "platejs/react";
import type * as React from "react";

import { cn } from "../lib/utils";

const editorContainerVariants = cva(
  'relative w-full cursor-text overflow-y-auto font-sans caret-primary selection:bg-primary/25 focus-visible:outline-hidden [&_.slate-selection-area]:bg-primary/15',
  {
    defaultVariants: {
      variant: "default",
    },
    variants: {
      variant: {
        comment: cn(
          "flex flex-wrap justify-between gap-1 px-1 py-0.5 text-sm",
          // No focus ring: the comment field sits in the editor's own surface, as text does.
          "rounded-md border-[1.5px] border-transparent bg-transparent",
          "has-aria-disabled:border-input has-aria-disabled:bg-muted",
        ),
        default: "h-full",
        demo: "h-[650px]",
        select: cn(
          "group rounded-md border border-input ring-offset-background focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2",
          "has-data-readonly:w-fit has-data-readonly:cursor-default has-data-readonly:border-transparent has-data-readonly:focus-within:[box-shadow:none]",
        ),
      },
    },
  },
);

export function EditorContainer({
  className,
  variant,
  ...props
}: React.HTMLAttributes<HTMLDivElement> &
  VariantProps<typeof editorContainerVariants>) {
  const editor = useEditorRef();

  return (
    <PlateContainer
      className={cn(
        "ignore-click-outside/toolbar",
        editorContainerVariants({ variant }),
        className,
      )}
      onClick={(e) => {
        if (variant === "comment") {
          e.preventDefault();
          editor.tf.focus({ edge: "endEditor" });
        }
      }}
      onMouseDown={(e) => {
        if (variant === "comment") {
          e.stopPropagation();
          e.preventDefault();
        }
      }}
      {...props}
    />
  );
}

const editorVariants = cva(
  cn(
    "group/editor",
    "relative w-full overflow-x-hidden whitespace-pre-wrap break-words",
    "rounded-md ring-offset-background placeholder:text-muted-foreground/80 focus-visible:outline-hidden",
    "**:data-slate-placeholder:!top-1/2 **:data-slate-placeholder:-translate-y-1/2 **:data-slate-placeholder:text-muted-foreground/80 **:data-slate-placeholder:opacity-100!",
    "[&_strong]:font-bold",
  ),
  {
    defaultVariants: {
      variant: "default",
    },
    variants: {
      disabled: {
        true: "cursor-not-allowed opacity-50",
      },
      focused: {
        true: "ring-2 ring-ring ring-offset-2",
      },
      variant: {
        ai: "px-0 text-base md:text-sm",
        aiChat:
          "max-h-[min(70vh,320px)] max-w-[700px] overflow-y-auto px-3 py-2 text-base md:text-sm",
        // The caret marks focus; the host app's fallback focus outline is unlayered, hence important.
        comment: cn("rounded-md border-none bg-transparent text-sm focus-visible:outline-hidden!"),
        default:
          "min-h-full px-[100px] pb-72 text-base sm:px-[max(100px,calc(50%-350px))]",
        demo: "h-full px-[100px] pt-4 pb-72 text-base sm:px-[max(100px,calc(50%-350px))]",
        fullWidth: "min-h-full px-[100px] pb-72 text-base",
        select: "px-3 py-2 text-base data-readonly:w-fit",
        update: "px-0 text-sm",
        versionHistory: "px-0 pb-[30vh] text-base",
      },
    },
  },
);

export type EditorProps = PlateContentProps &
  VariantProps<typeof editorVariants> & {
    ref?: React.Ref<HTMLDivElement>;
  };

export function Editor({
  className,
  disabled,
  focused,
  variant,
  onClick,
  onMouseDown,
  ref,
  ...props
}: EditorProps) {
  return (
    <PlateContent
      className={cn(
        editorVariants({
          disabled,
          focused,
          variant,
        }),
        className,
      )}
      disableDefaultStyles
      onClick={(e) => {
        if (variant === "comment") {
          e.stopPropagation();
        }

        onClick?.(e);
      }}
      onMouseDown={(e) => {
        if (variant === "comment") {
          e.stopPropagation();
        }

        onMouseDown?.(e);
      }}
      ref={ref}
      {...props}
    />
  );
}
