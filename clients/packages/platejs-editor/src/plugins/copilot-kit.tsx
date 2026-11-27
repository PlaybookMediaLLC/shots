"use client";

import { CopilotPlugin } from "@platejs/ai/react";
import { serializeMd, stripMarkdown } from "@platejs/markdown";
import { NodeApi, PathApi, RangeApi, type TElement } from "platejs";
import { useEffect } from "react";

import { GhostText } from "../ui/ghost-text";
import { getCopilotContext } from "../lib/copilot-context";
import { useEditorServices } from "../lib/editor-services";

import { MarkdownKit } from "./markdown-kit";

const MAX_CONTEXT_BLOCK_CHARS = 1800;

/** Pause before requesting an inline ghost-text suggestion. */
const COPILOT_DEBOUNCE_DELAY_MS = 1000;

type CopilotRequestSnapshot = {
  blockId: string;
  blockPath: number[];
  prompt: string;
  selection: {
    anchor: { offset: number; path: number[] };
    focus: { offset: number; path: number[] };
  };
};

const pendingSnapshots = new WeakMap<object, CopilotRequestSnapshot>();

const serializeContextBlock = (
  editor: Parameters<typeof serializeMd>[0],
  node?: TElement
): string => {
  if (!node) return "(none)";
  return serializeMd(editor, { value: [node] })
    .trim()
    .slice(0, MAX_CONTEXT_BLOCK_CHARS);
};

const getCopilotPrompt = (
  editor: Parameters<typeof serializeMd>[0]
): string => {
  const blockEntry = editor.api.block({ highest: true });
  const currentIndex = blockEntry?.[1][0];
  if (currentIndex === undefined) return "";

  const context = getCopilotContext(editor.children, currentIndex);
  if (!context) return "";

  return [
    "Continue Current block through the next punctuation mark.",
    `Document title: ${context.title ?? "Untitled"}`,
    `Heading path: ${context.headingPath.join(" > ") || "(none)"}`,
    `Previous block:\n${serializeContextBlock(editor, context.previous)}`,
    `Current block:\n${serializeContextBlock(editor, context.current)}`,
    `Next block:\n${serializeContextBlock(editor, context.next)}`,
  ].join("\n\n");
};

export const CopilotKit = [
  ...MarkdownKit,
  CopilotPlugin.configure(({ api, editor }) => ({
    options: {
      autoTriggerQuery: ({ editor: currentEditor }) => {
        const options = currentEditor.getOptions(CopilotPlugin);
        if (!options.completeOptions?.api || options.suggestionText) {
          return false;
        }
        if (
          currentEditor.api.isEmpty(currentEditor.selection, { block: true })
        ) {
          return false;
        }
        const blockAbove = currentEditor.api.block();
        if (!blockAbove) return false;
        return NodeApi.string(blockAbove[0]).at(-1) === " ";
      },
      // The endpoint comes from the host's `ai.copilot` service (useHooks
      // below). Until one is set, getPrompt returns "" and nothing is sent.
      completeOptions: {
        onFinish: (sentPrompt, completion) => {
          const snapshot = pendingSnapshots.get(editor);
          if (!snapshot || snapshot.prompt !== sentPrompt) return;
          pendingSnapshots.delete(editor);

          const trimmed = completion.trim();
          if (!trimmed || trimmed === "0") return;
          if (!editor.getOptions(CopilotPlugin).completeOptions?.api) return;
          if (
            !editor.selection ||
            editor.api.isExpanded() ||
            !editor.api.isAt({ end: true })
          ) {
            return;
          }
          const lowestBlock = editor.api.block();
          if (!lowestBlock) return;
          const blockId = lowestBlock[0].id;
          if (typeof blockId !== "string" || !blockId) return;
          if (!PathApi.equals(lowestBlock[1], snapshot.blockPath)) return;
          if (blockId !== snapshot.blockId) return;
          if (!RangeApi.equals(editor.selection, snapshot.selection)) return;
          if (getCopilotPrompt(editor) !== sentPrompt) return;

          const text = stripMarkdown(completion);
          if (!text.trim()) return;

          api.copilot.setBlockSuggestion({ id: blockId, text });
        },
      },
      debounceDelay: COPILOT_DEBOUNCE_DELAY_MS,
      renderGhostText: GhostText,
      getPrompt: ({ editor: currentEditor }) => {
        if (!currentEditor.getOptions(CopilotPlugin).completeOptions?.api) {
          pendingSnapshots.delete(currentEditor);
          return "";
        }
        const lowestBlock = currentEditor.api.block();
        const blockId = lowestBlock?.[0].id;
        if (
          !lowestBlock ||
          typeof blockId !== "string" ||
          !blockId ||
          !currentEditor.selection
        ) {
          pendingSnapshots.delete(currentEditor);
          return "";
        }
        const prompt = getCopilotPrompt(currentEditor);
        if (!prompt) {
          pendingSnapshots.delete(currentEditor);
          return "";
        }
        pendingSnapshots.set(currentEditor, {
          blockId,
          blockPath: [...lowestBlock[1]],
          prompt,
          selection: {
            anchor: {
              offset: currentEditor.selection.anchor.offset,
              path: [...currentEditor.selection.anchor.path],
            },
            focus: {
              offset: currentEditor.selection.focus.offset,
              path: [...currentEditor.selection.focus.path],
            },
          },
        });
        return prompt;
      },
    },
    handlers: {
      onBlur: ({ api: pluginApi, editor: currentEditor }) => {
        pendingSnapshots.delete(currentEditor);
        pluginApi.copilot.stop();
        pluginApi.copilot.reject();
      },
      onMouseDown: ({ api: pluginApi, editor: currentEditor }) => {
        pendingSnapshots.delete(currentEditor);
        pluginApi.copilot.stop();
        pluginApi.copilot.reject();
      },
    },
    useHooks: ({ api: pluginApi, editor: currentEditor }) => {
      const copilot = useEditorServices().ai?.copilot;
      useEffect(() => {
        const current = currentEditor.getOptions(CopilotPlugin).completeOptions;
        const apiChanged = current?.api !== copilot?.api;
        if (!copilot?.api || apiChanged) {
          pendingSnapshots.delete(currentEditor);
          pluginApi.copilot.stop();
          currentEditor.setOptions(CopilotPlugin, {
            suggestionNodeId: null,
            suggestionText: null,
          });
        }
        if (apiChanged || current?.fetch !== copilot?.fetch) {
          currentEditor.setOption(CopilotPlugin, "completeOptions", {
            ...current,
            api: copilot?.api,
            fetch: copilot?.fetch,
          });
        }
      }, [copilot?.api, copilot?.fetch, currentEditor, pluginApi]);
      useEffect(
        () => () => {
          pendingSnapshots.delete(currentEditor);
          pluginApi.copilot.stop();
        },
        [currentEditor, pluginApi]
      );
    },
    shortcuts: {
      accept: {
        keys: "tab",
      },
      acceptNextWord: {
        keys: "mod+right",
      },
      reject: {
        keys: "escape",
      },
      triggerSuggestion: {
        keys: "ctrl+space",
      },
    },
  })).overrideEditor(({ api, editor, getOptions, tf: { apply } }) => ({
    transforms: {
      apply(operation) {
        if (getOptions().shouldAbort) {
          pendingSnapshots.delete(editor);
          api.copilot.stop();
        }
        apply(operation);
      },
    },
  })),
];
