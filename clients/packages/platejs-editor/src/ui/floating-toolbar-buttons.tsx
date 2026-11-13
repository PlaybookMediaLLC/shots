"use client";

import { TextBIcon as Bold } from "@phosphor-icons/react/dist/ssr/TextB"
import { CodeIcon as Code2 } from "@phosphor-icons/react/dist/ssr/Code"
import { HighlighterIcon as HighlighterIcon } from "@phosphor-icons/react/dist/ssr/Highlighter"
import { TextItalicIcon as Italic } from "@phosphor-icons/react/dist/ssr/TextItalic"
import { KeyboardIcon as KeyboardIcon } from "@phosphor-icons/react/dist/ssr/Keyboard"
import { TextStrikethroughIcon as Strikethrough } from "@phosphor-icons/react/dist/ssr/TextStrikethrough"
import { TextUnderlineIcon as Underline } from "@phosphor-icons/react/dist/ssr/TextUnderline"
import { SparkleIcon } from "@phosphor-icons/react/dist/ssr/Sparkle";
import { cn } from "../lib/utils";
import type { IconProps } from "@phosphor-icons/react";
import { KEYS } from "platejs";
import {
  useEditorReadOnly,
  useEditorRef,
  useSelectionAcrossBlocks,
} from "platejs/react";

import { AIToolbarButton } from "./ai-toolbar-button";
import { AlignToolbarButton } from "./align-toolbar-button";
import { CommentToolbarButton } from "./comment-toolbar-button";
import { InlineEquationToolbarButton } from "./equation-toolbar-button";
import { FontColorToolbarButton } from "./font-color-toolbar-button";
import { FontWeightToolbarButton } from "./font-weight-toolbar-button";
import { LinkToolbarButton } from "./link-toolbar-button";
import { LineHeightToolbarButton } from "./line-height-toolbar-button";
import { MarkToolbarButton } from "./mark-toolbar-button";
import { MoreToolbarButton } from "./more-toolbar-button";
import { SuggestionToolbarButton } from "./suggestion-toolbar-button";
import { ToolbarGroup } from "./toolbar";
import {
  TextIndentDecreaseToolbarButton,
  TextIndentIncreaseToolbarButton,
} from "./text-indent-toolbar-button";
import { TurnIntoToolbarButton } from "./turn-into-toolbar-button";

export function FloatingToolbarButtons() {
  const editor = useEditorRef();
  const readOnly = useEditorReadOnly();

  const isSelectionAcrossBlocks = useSelectionAcrossBlocks();

  return (
    <div
      className="flex"
      style={{
        transform: "translateX(calc(-1px))",
        whiteSpace: "nowrap",
      }}
    >
      {!readOnly && (
        <>
          {editor.plugins[KEYS.aiChat] && (
            <ToolbarGroup>
              <AIToolbarButton
                className="gap-1.5"
                shortcut="⌘+J"
                tooltip="Edit, generate, and more"
              >
                <AIIcon className="!size-3" />
                <div className="hidden sm:inline">
                  Ask AI
                </div>
              </AIToolbarButton>
            </ToolbarGroup>
          )}

          <ToolbarGroup>
            {editor.plugins[KEYS.comment] && <CommentToolbarButton />}
            {editor.plugins[KEYS.suggestion] && <SuggestionToolbarButton />}
          </ToolbarGroup>
          <ToolbarGroup>
            <TurnIntoToolbarButton />

            <MarkToolbarButton
              nodeType={KEYS.bold}
              shortcut="⌘+B"
              tooltip="Bold"
            >
              <Bold />
            </MarkToolbarButton>

            <MarkToolbarButton
              nodeType={KEYS.italic}
              shortcut="⌘+I"
              tooltip="Italic"
            >
              <Italic />
            </MarkToolbarButton>

            <MarkToolbarButton
              nodeType={KEYS.underline}
              shortcut="⌘+U"
              tooltip="Underline"
            >
              <Underline />
            </MarkToolbarButton>

            <MarkToolbarButton
              nodeType={KEYS.strikethrough}
              shortcut="⌘+Shift+X"
              tooltip="Strikethrough"
            >
              <Strikethrough />
            </MarkToolbarButton>

            <MarkToolbarButton
              nodeType={KEYS.code}
              shortcut="⌘+E"
              tooltip="Code"
            >
              <Code2 />
            </MarkToolbarButton>

            <MarkToolbarButton
              nodeType={KEYS.highlight}
              shortcut="⌘+Shift+H"
              tooltip="Highlight"
            >
              <HighlighterIcon />
            </MarkToolbarButton>

            <MarkToolbarButton nodeType={KEYS.kbd} tooltip="Keyboard key">
              <KeyboardIcon />
            </MarkToolbarButton>

            <InlineEquationToolbarButton />

            <LinkToolbarButton />

            <FontColorToolbarButton />
            <FontWeightToolbarButton />
          </ToolbarGroup>
          <ToolbarGroup>
            <AlignToolbarButton />
            <LineHeightToolbarButton />
            <TextIndentDecreaseToolbarButton />
            <TextIndentIncreaseToolbarButton />
          </ToolbarGroup>
          <ToolbarGroup>
            {!isSelectionAcrossBlocks && <MoreToolbarButton />}
          </ToolbarGroup>
        </>
      )}
    </div>
  );
}

/** The AI mark: Phosphor's sparkle in the accent color. */
function AIIcon({ className, ...props }: IconProps) {
  return <SparkleIcon className={cn("text-primary", className)} {...props} />;
}
