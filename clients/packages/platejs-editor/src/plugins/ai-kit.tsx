"use client";

import { withAIBatch } from "@platejs/ai";
import type { AIChatPluginConfig } from "@platejs/ai/react";
import {
  AIChatPlugin,
  AIPlugin,
  applyAISuggestions,
  streamInsertChunk,
  useChatChunk,
} from "@platejs/ai/react";
import { KEYS, PathApi } from "platejs";
import { type PlateEditor, usePluginOption } from "platejs/react";
import type React from "react";
import { useEffect } from "react";
import { useStickToBottom } from "use-stick-to-bottom";
import { aiWriter, discardOwnAI, recordAISuggestions } from "./ai-ownership";
import { AIMenu } from "../ui/ai-menu";
import { AIAnchorElement, AILeaf } from "../ui/ai-node";
import { CursorOverlayKit } from "./cursor-overlay-kit";
import { MarkdownKit } from "./markdown-kit";

const applyStreamingEdit = (
  editor: Parameters<typeof applyAISuggestions>[0],
  content: string,
  split: boolean
): void => {
  recordAISuggestions(editor as PlateEditor, () =>
    withAIBatch(editor, () => applyAISuggestions(editor, content), { split })
  );
};

export const aiChatPlugin = AIChatPlugin.extend({
  options: {
    contentRef: null as
      | (React.RefObject<HTMLElement | null> & React.RefCallback<HTMLElement>)
      | null,
    scrollRef: null as
      | (React.RefObject<HTMLElement | null> & React.RefCallback<HTMLElement>)
      | null,
  },
}).configure({
  render: {
    afterEditable: AIMenu,
    node: AIAnchorElement,
  },
  shortcuts: { show: { keys: "mod+j" } },
  useHooks: ({ api, editor, getOption, setOptions }) => {
    const { contentRef, escapedFromLock, scrollRef, scrollToBottom } =
      useStickToBottom({
        /** Replace "bottom of the scroll container" with "top of the anchor" */
        targetScrollTop: (_defaultBottom, { scrollElement }) => {
          const anchorNode = api.aiChat.node({ anchor: true });

          if (!anchorNode) return 0; // fallback: real bottom

          const anchor = api.toDOMNode(anchorNode[0])?.parentElement
            ?.parentElement as HTMLDivElement;

          if (!anchor) return 0; // fallback: real bottom

          const scrollRect = scrollElement.getBoundingClientRect();
          const anchorRect = anchor.getBoundingClientRect();

          // Add a threshold of 100px from the bottom
          const threshold = 100;
          const isVisible =
            anchorRect.top >= scrollRect.top &&
            anchorRect.bottom <= scrollRect.bottom - threshold;

          const anchorTop = anchor.offsetTop - scrollElement.offsetTop;

          return isVisible ? 0 : anchorTop;
        },
      });

    useEffect(() => {
      setOptions({ contentRef, scrollRef });
    }, [contentRef, scrollRef, setOptions]);

    const mode = usePluginOption(
      { key: "aiChat" } as AIChatPluginConfig,
      "mode"
    );
    const toolName = usePluginOption(AIChatPlugin, "toolName");

    useChatChunk({
      onChunk: ({ chunk, isFirst, nodes, text }) => {
        if (isFirst && mode === "insert") {
          editor.tf.withoutSaving(() => {
            editor.tf.insertNodes(
              {
                children: [{ text: "" }],
                type: KEYS.aiChat,
              },
              {
                at: PathApi.next(
                  editor.selection?.focus.path.slice(0, 1) as number[]
                ),
              }
            );
          });
          editor.setOption(AIChatPlugin, "streaming", true);
        }
        if (mode === "insert" && nodes.length > 0) {
          withAIBatch(
            editor,
            () => {
              if (!getOption("streaming")) return;

              streamInsertChunk(editor, chunk, {
                textProps: {
                  ai: true,
                  aiBy: aiWriter(editor).id,
                },
              });

              if (!escapedFromLock) {
                Promise.resolve(scrollToBottom("smooth")).catch(() => {
                  // Ignore scroll sync failures while streaming editor content.
                });
              }
            },
            { split: isFirst }
          );
        }
        if (toolName === "edit" && mode === "chat") {
          applyStreamingEdit(editor, text, isFirst);
        }
      },
      onFinish: () => {
        editor.setOption(AIChatPlugin, "streaming", false);
        editor.setOption(AIChatPlugin, "_blockChunks", "");
        editor.setOption(AIChatPlugin, "_blockPath", null);
      },
    });
  },
});

/**
 * Discarding takes back this editor's own unaccepted AI text. Upstream undoes
 * the last history batch, which in a shared document also held typed words.
 */
const DiscardingAIPlugin = AIPlugin.withComponent(AILeaf).extendTransforms(
  ({ editor }) => ({
    undo: () => discardOwnAI(editor),
  })
);

export const AIKit = [
  ...CursorOverlayKit,
  ...MarkdownKit,
  DiscardingAIPlugin,
  aiChatPlugin,
];

const systemCommon = `\
You are an advanced AI-powered note-taking assistant, designed to enhance productivity and creativity in note management.
Respond directly to user prompts with clear, concise, and relevant content. Maintain a neutral, helpful tone.

Rules:
- <Document> is the entire note the user is working on.
- <Reminder> is a reminder of how you should reply to INSTRUCTIONS. It does not apply to questions.
- Anything else is the user prompt.
- Your response should be tailored to the user's prompt, providing precise assistance to optimize note management.
- For INSTRUCTIONS: Follow the <Reminder> exactly. Provide ONLY the content to be inserted or replaced. No explanations or comments.
- For QUESTIONS: Provide a helpful and concise answer. You may include brief explanations if necessary.
- CRITICAL: Distinguish between INSTRUCTIONS and QUESTIONS. Instructions typically ask you to modify or add content. Questions ask for information or clarification.
- CRITICAL: When writing the column, such line breaks and indentation must be preserved.
<column_group>
  <column>
    1
  </column>
  <column>
    2
  </column>
  <column>
    3
  </column>
</column_group>
`;

const systemDefault = `\
${systemCommon}
- <Block> is the current block of text the user is working on.
- Ensure your output can seamlessly fit into the existing <Block> structure.

<Block>
{block}
</Block>
`;

const systemSelecting = `\
${systemCommon}
- <Block> is the block of text containing the user's selection, providing context.
- Ensure your output can seamlessly fit into the existing <Block> structure.
- <Selection> is the specific text the user has selected in the block and wants to modify or ask about.
- Consider the context provided by <Block>, but only modify <Selection>. Your response should be a direct replacement for <Selection>.
<Block>
{block}
</Block>
<Selection>
{selection}
</Selection>
`;

const systemBlockSelecting = `\
${systemCommon}
- <Selection> represents the full blocks of text the user has selected and wants to modify or ask about.
- Your response should be a direct replacement for the entire <Selection>.
- Maintain the overall structure and formatting of the selected blocks, unless explicitly instructed otherwise.
- CRITICAL: Provide only the content to replace <Selection>. Do not add additional blocks or change the block structure unless specifically requested.
<Selection>
{block}
</Selection>
`;

const userDefault = `<Reminder>
CRITICAL: NEVER write <Block>.
</Reminder>
{prompt}
<Document>
{editor}
</Document>
`;

const userSelecting = `<Reminder>
If this is a question, provide a helpful and concise answer about <Selection>.
If this is an instruction, provide ONLY the text to replace <Selection>. No explanations.
Ensure it fits seamlessly within <Block>. If <Block> is empty, write ONE random sentence.
NEVER write <Block> or <Selection>.
</Reminder>
{prompt} about <Selection>`;

const userBlockSelecting = `<Reminder>
If this is a question, provide a helpful and concise answer about <Selection>.
If this is an instruction, provide ONLY the content to replace the entire <Selection>. No explanations.
Maintain the overall structure unless instructed otherwise.
NEVER write <Block> or <Selection>.
</Reminder>
{prompt} about <Selection>`;

export const PROMPT_TEMPLATES = {
  systemBlockSelecting,
  systemDefault,
  systemSelecting,
  userBlockSelecting,
  userDefault,
  userSelecting,
};
