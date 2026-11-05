"use client";

import { SuggestionPlugin } from "@platejs/suggestion/react";
import { PencilLineIcon as PencilLineIcon } from "@phosphor-icons/react/dist/ssr/PencilLine";
import { useEditorPlugin, usePluginOption } from "platejs/react";

import { cn } from "../lib/utils";

import { ToolbarButton } from "./toolbar";

export function SuggestionToolbarButton() {
  const { setOption } = useEditorPlugin(SuggestionPlugin);
  const isSuggesting = usePluginOption(SuggestionPlugin, "isSuggesting");

  return (
    <ToolbarButton
      className={cn(isSuggesting && "text-primary/80 hover:text-primary/80")}
      onClick={() => setOption("isSuggesting", !isSuggesting)}
      onMouseDown={(e) => e.preventDefault()}
      tooltip={isSuggesting ? "Turn off suggesting" : "Suggestion edits"}
    >
      <PencilLineIcon />
    </ToolbarButton>
  );
}
