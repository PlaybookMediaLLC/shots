"use client";

import {
  AIChatPlugin,
  AIPlugin,
  useEditorChat,
} from "@platejs/ai/react";
import { BlockSelectionPlugin, useIsSelecting } from "@platejs/selection/react";
import { ImagesIcon as AlbumIcon } from "@phosphor-icons/react/dist/ssr/Images"
import { ArrowUpIcon as ArrowUpIcon } from "@phosphor-icons/react/dist/ssr/ArrowUp"
import { QuestionIcon as BadgeHelpIcon } from "@phosphor-icons/react/dist/ssr/Question"
import { CheckIcon as CheckIcon } from "@phosphor-icons/react/dist/ssr/Check"
import { ArrowBendUpLeftIcon as CornerUpLeftIcon } from "@phosphor-icons/react/dist/ssr/ArrowBendUpLeft"
import { FeatherIcon as FeatherIcon } from "@phosphor-icons/react/dist/ssr/Feather"
import { TranslateIcon as LanguagesIcon } from "@phosphor-icons/react/dist/ssr/Translate"
import { ListIcon as ListEnd } from "@phosphor-icons/react/dist/ssr/List"
import { ListIcon as ListMinusIcon } from "@phosphor-icons/react/dist/ssr/List"
import { ListPlusIcon as ListPlusIcon } from "@phosphor-icons/react/dist/ssr/ListPlus"
import { ChatTextIcon as MessageSquareTextIcon } from "@phosphor-icons/react/dist/ssr/ChatText"
import { PenIcon as PenLineIcon } from "@phosphor-icons/react/dist/ssr/Pen"
import { TableIcon as TableIcon } from "@phosphor-icons/react/dist/ssr/Table"
import { MagicWandIcon as Wand } from "@phosphor-icons/react/dist/ssr/MagicWand"
import { XIcon as X } from "@phosphor-icons/react/dist/ssr/X";
import { isHotkey, NodeApi, type NodeEntry, type SlateEditor } from "platejs";
import {
  type PlateEditor,
  useEditorPlugin,
  useEditorRef,
  useHotkeys,
  usePluginOption,
} from "platejs/react";
import { type ComponentType, type ReactNode, useEffect, useMemo } from "react";
import { useChat } from "../components/use-chat";
import { useAIQuality } from "../hooks/use-ai-quality";
import {
  dispatchEditorAIComment,
  dispatchEditorAIQuality,
  editorActionForTool,
  type EditorAIQualityEventDetail,
} from "../lib/ai-editor";
import { cn } from "../lib/utils";

import { AIChatEditor } from "./ai-chat-editor";
import { Button } from "./button";
import {
  type Action,
  ComboboxContent,
  ComboboxInput,
  ComboboxList,
  filterMenuGroups,
  filterMenuItems,
  Menu,
  MenuContent,
  MenuGroup,
  MenuItem,
  MenuTrigger,
  useComboboxValueState,
  useMenuStore,
} from "./menu";
import { TextareaAutosize } from "./textarea";

const ignoreAiMenuPromise = <T,>(result: Promise<T> | T) => {
  Promise.resolve(result).catch(() => {
    // Ignore menu-triggered AI errors; the editor state surfaces failures.
  });
};

const emitQuality = (
  editor: PlateEditor,
  event: EditorAIQualityEventDetail["event"]
): void => {
  const toolName = editor.getOption(AIChatPlugin, "toolName");
  dispatchEditorAIQuality({
    action: editorActionForTool(toolName),
    event,
    mode: editor.getOption(AIChatPlugin, "mode"),
  });
};

const getAssistantText = (editor: PlateEditor): string => {
  const messages = editor.getOption(AIChatPlugin, "chat").messages;
  const message = messages.findLast((item) => item.role === "assistant");
  return (
    message?.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("") ?? ""
  );
};

export function AIMenu() {
  const { api, editor } = useEditorPlugin(AIChatPlugin);
  const open = usePluginOption(AIChatPlugin, "open");
  const mode = usePluginOption(AIChatPlugin, "mode");
  const toolName = usePluginOption(AIChatPlugin, "toolName");
  const isSelecting = useIsSelecting();
  const streaming = usePluginOption(AIChatPlugin, "streaming");

  const chat = useChat();
  const { input, messages, setInput, status } = chat;
  const isLoading = status === "streaming" || status === "submitted";
  useAIQuality({ mode, status, toolName });

  const lastMessage = messages.findLast((message) => message.role === "assistant");
  const content = lastMessage?.parts
    ?.filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("");

  const { show, store } = useMenuStore();

  useEffect(() => {
    if (streaming) {
      const anchor = api.aiChat.node({ anchor: true });
      setTimeout(() => {
        const anchorNode = anchor?.[0];
        if (!anchorNode) {
          return;
        }

        const anchorDom = editor.api.toDOMNode(anchorNode);
        if (anchorDom) {
          store.setAnchorElement(anchorDom);
        }
      }, 0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    streaming,
    api.aiChat.node,
    editor.api.toDOMNode,
    store.setAnchorElement,
  ]);

  useEditorChat({
    onOpenBlockSelection: (blocks: NodeEntry[]) => {
      const blockEntry = blocks.at(-1);
      if (!blockEntry) {
        return;
      }

      const blockDom = editor.api.toDOMNode(blockEntry[0]);
      if (blockDom) {
        show(blockDom);
      }
    },
    onOpenChange: (nextOpen) => {
      if (!nextOpen) {
        store.hideAll();
        setInput("");
      }
    },
    onOpenCursor: () => {
      const ancestorEntry = editor.api.block({ highest: true });
      if (!ancestorEntry) {
        return;
      }

      const [ancestor] = ancestorEntry;

      if (!(editor.api.isAt({ end: true }) || editor.api.isEmpty(ancestor))) {
        editor
          .getApi(BlockSelectionPlugin)
          .blockSelection.set(ancestor.id as string);
      }

      const ancestorDom = editor.api.toDOMNode(ancestor);
      if (ancestorDom) {
        show(ancestorDom);
      }
    },
    onOpenSelection: () => {
      const blockEntry = editor.api.blocks().at(-1);
      if (!blockEntry) {
        return;
      }

      const blockDom = editor.api.toDOMNode(blockEntry[0]);
      if (blockDom) {
        show(blockDom);
      }
    },
  });

  useHotkeys("escape", () => {
    if (isLoading) {
      api.aiChat.stop();
    } else {
      api.aiChat.hide();
    }
  });

  return (
    <Menu open={open} placement="bottom-start" store={store}>
      <MenuContent
        flip={false}
        onClickOutside={() => {
          api.aiChat.hide();
        }}
        variant="ai"
        wrapperProps={{
          // FIXME: It is best to set it to 100.
          // But it will cause a horizontal scrollbar to appear.
          // A method should be found to disable translate-x.
          className: "w-[98%]!",
        }}
      >
        <ComboboxContent variant="ai">
          {mode === "chat" && isSelecting && content && (
            <AIChatEditor content={content} />
          )}

          <div className="flex gap-1.5 px-3 text-sm">
            {isLoading ? (
              <div className="flex grow select-none items-center gap-2 py-2 text-muted-foreground">
                {messages.length > 1 ? "Editing" : "Thinking"}

                <LoadingIcon />
              </div>
            ) : (
              <AIMenuCombobox input={input} setInput={setInput} />
            )}

            <Button
              className="outline-none mt-1 shrink-0"
              disabled={!isLoading && input.trim().length === 0}
              onClick={() => {
                if (isLoading) {
                  emitQuality(editor, "stopped");
                  api.aiChat.stop();
                } else {
                  ignoreAiMenuPromise(api.aiChat.submit(input));
                  setInput("");
                }
              }}
              size="iconSm"
              variant="ghost"
            >
              {isLoading ? <StopIcon /> : <SubmitIcon />}
            </Button>
          </div>
        </ComboboxContent>

        {!isLoading && (
          <ComboboxList
            className={cn("[&_.menu-item-icon]:text-purple-700")}
            variant="ai"
          >
            <AIMenuItems />
          </ComboboxList>
        )}
      </MenuContent>
    </Menu>
  );
}

type EditorChatState =
  | "commentSuggestion"
  | "cursorCommand"
  | "cursorSuggestion"
  | "editSuggestion"
  | "selectionCommand"
  | "selectionSuggestion";

interface AIChatItemDefinition {
  component?: ComponentType<{ menuState: EditorChatState }>;
  filterItems?: boolean;
  icon?: ReactNode;
  items?: { label: string; value: string }[];
  label?: string;
  onSelect?: ({
    aiEditor,
    editor,
  }: {
    aiEditor: SlateEditor;
    editor: PlateEditor;
  }) => void;
  shortcut?: string;
  value?: string;
}

const GROUP = {
  LANGUAGES: "group_languages",
  SELECTION_LANGUAGES: "group_selection_languages",
} as const;

const aiChatItems = {
  accept: {
    icon: <CheckIcon />,
    label: "Accept",
    value: "accept",
    onSelect: ({ editor }) => {
      emitQuality(editor, "accepted");
      editor.getTransforms(AIChatPlugin).aiChat.accept();
      if (editor.selection) {
        editor.tf.focus({ at: editor.api.end(editor.selection) });
      }
    },
  },
  addComment: {
    icon: <MessageSquareTextIcon />,
    label: "Add comment",
    value: "addComment",
    onSelect: ({ editor }) => {
      const comment = getAssistantText(editor).trim();
      if (!comment) return;

      dispatchEditorAIComment({ comment, editorId: String(editor.id) });
      emitQuality(editor, "accepted");
      editor.getApi(AIChatPlugin).aiChat.hide({ undo: false });
    },
  },
  actionItems: {
    icon: <ListMinusIcon />,
    label: "Action items",
    value: "actionItems",
    onSelect: ({ editor }) => {
      ignoreAiMenuPromise(
        editor.getApi(AIChatPlugin).aiChat.submit("", {
          prompt:
            "Extract actionable tasks with owners and due dates when possible",
          toolName: "generate",
        })
      );
    },
  },
  continueWrite: {
    icon: <PenLineIcon />,
    label: "Continue writing",
    value: "continueWrite",
    onSelect: ({ editor }) => {
      const ancestorNode = editor.api.block({ highest: true });

      if (!ancestorNode) return;

      const isEmpty = NodeApi.string(ancestorNode[0]).trim().length === 0;

      ignoreAiMenuPromise(
        editor.getApi(AIChatPlugin).aiChat.submit("", {
          mode: "insert",
          prompt: isEmpty
            ? `<Document>
{editor}
</Document>
Start writing a new paragraph AFTER <Document> ONLY ONE SENTENCE`
            : "Continue writing AFTER <Block> ONLY ONE SENTENCE. DONT REPEAT THE TEXT.",
          toolName: "generate",
        })
      );
    },
  },
  discard: {
    icon: <X />,
    label: "Discard",
    shortcut: "Escape",
    value: "discard",
    onSelect: ({ editor }) => {
      emitQuality(editor, "discarded");
      editor.getTransforms(AIPlugin).ai.undo();
      editor.getApi(AIChatPlugin).aiChat.hide();
    },
  },
  explain: {
    icon: <BadgeHelpIcon />,
    label: "Explain",
    value: "explain",
    onSelect: ({ editor }) => {
      ignoreAiMenuPromise(
        editor.getApi(AIChatPlugin).aiChat.submit("", {
          prompt: {
            default: "Explain {editor}",
            selecting: "Explain",
          },
          toolName: "generate",
        })
      );
    },
  },
  fixSpelling: {
    icon: <CheckIcon />,
    label: "Fix spelling & grammar",
    value: "fixSpelling",
    onSelect: ({ editor }) => {
      ignoreAiMenuPromise(
        editor.getApi(AIChatPlugin).aiChat.submit("", {
          prompt: "Fix spelling and grammar",
          toolName: "edit",
        })
      );
    },
  },
  [GROUP.LANGUAGES]: {
    component: TranslateMenuItems,
    filterItems: true,
    icon: <LanguagesIcon className="text-green-800" />,
    items: [
      { label: "English", value: "translate_english" },
      { label: "Korean", value: "translate_korean" },
      {
        label: "Chinese, Simplified",
        value: "translate_chinese_simplified",
      },
      {
        label: "Chinese, Traditional",
        value: "translate_chinese_traditional",
      },
      { label: "Japanese", value: "translate_japanese" },
      { label: "Spanish", value: "translate_spanish" },
      { label: "Russian", value: "translate_russian" },
      { label: "French", value: "translate_french" },
      { label: "Portuguese", value: "translate_portuguese" },
      { label: "German", value: "translate_german" },
      { label: "Italian", value: "translate_italian" },
      { label: "Dutch", value: "translate_dutch" },
      { label: "Indonesian", value: "translate_indonesian" },
      { label: "Filipino", value: "translate_filipino" },
      { label: "Vietnamese", value: "translate_vietnamese" },
      { label: "Turkish", value: "translate_turkish" },
      { label: "Arabic", value: "translate_arabic" },
    ],
    label: "Languages",
    value: GROUP.LANGUAGES,
  },
  [GROUP.SELECTION_LANGUAGES]: {
    component: TranslateMenuItems,
    filterItems: true,
    icon: <LanguagesIcon className="text-green-800" />,
    items: [
      { label: "English", value: "translate_english" },
      { label: "Korean", value: "translate_korean" },
      {
        label: "Chinese, Simplified",
        value: "translate_chinese_simplified",
      },
      {
        label: "Chinese, Traditional",
        value: "translate_chinese_traditional",
      },
      { label: "Japanese", value: "translate_japanese" },
      { label: "Spanish", value: "translate_spanish" },
      { label: "Russian", value: "translate_russian" },
      { label: "French", value: "translate_french" },
      { label: "Portuguese", value: "translate_portuguese" },
      { label: "German", value: "translate_german" },
      { label: "Italian", value: "translate_italian" },
      { label: "Dutch", value: "translate_dutch" },
      { label: "Indonesian", value: "translate_indonesian" },
      { label: "Filipino", value: "translate_filipino" },
      { label: "Vietnamese", value: "translate_vietnamese" },
      { label: "Turkish", value: "translate_turkish" },
      { label: "Arabic", value: "translate_arabic" },
    ],
    label: "Languages",
    value: GROUP.LANGUAGES,
  },
  improveWriting: {
    icon: <Wand />,
    label: "Improve writing",
    value: "improveWriting",
    onSelect: ({ editor }) => {
      ignoreAiMenuPromise(
        editor.getApi(AIChatPlugin).aiChat.submit("", {
          prompt: "Improve the writing",
          toolName: "edit",
        })
      );
    },
  },
  insertBelow: {
    icon: <ListEnd />,
    label: "Insert below",
    value: "insertBelow",
    onSelect: ({ aiEditor, editor }) => {
      ignoreAiMenuPromise(
        editor.getTransforms(AIChatPlugin).aiChat.insertBelow(aiEditor)
      );
    },
  },
  keyPoints: {
    icon: <ListPlusIcon />,
    label: "Key points",
    value: "keyPoints",
    onSelect: ({ editor }) => {
      ignoreAiMenuPromise(
        editor.getApi(AIChatPlugin).aiChat.submit("", {
          prompt: "List the key points as bullet points",
          toolName: "generate",
        })
      );
    },
  },
  makeLonger: {
    icon: <ListPlusIcon />,
    label: "Make longer",
    value: "makeLonger",
    onSelect: ({ editor }) => {
      ignoreAiMenuPromise(
        editor.getApi(AIChatPlugin).aiChat.submit("", {
          prompt: "Make longer",
          toolName: "edit",
        })
      );
    },
  },
  makeShorter: {
    icon: <ListMinusIcon />,
    label: "Make shorter",
    value: "makeShorter",
    onSelect: ({ editor }) => {
      ignoreAiMenuPromise(
        editor.getApi(AIChatPlugin).aiChat.submit("", {
          prompt: "Make shorter",
          toolName: "edit",
        })
      );
    },
  },
  makeTable: {
    icon: <TableIcon />,
    label: "Create table from selection",
    value: "makeTable",
    onSelect: ({ editor }) => {
      ignoreAiMenuPromise(
        editor.getApi(AIChatPlugin).aiChat.submit("", {
          prompt: "Convert the selection into a markdown table",
          toolName: "edit",
        })
      );
    },
  },
  outline: {
    icon: <ListEnd />,
    label: "Create outline",
    value: "outline",
    onSelect: ({ editor }) => {
      ignoreAiMenuPromise(
        editor
          .getApi(AIChatPlugin)
          .aiChat.submit("", {
            prompt: "Create a hierarchical outline",
            toolName: "generate",
          })
      );
    },
  },
  replace: {
    icon: <CheckIcon />,
    label: "Replace selection",
    value: "replace",
    onSelect: ({ aiEditor, editor }) => {
      ignoreAiMenuPromise(
        editor.getTransforms(AIChatPlugin).aiChat.replaceSelection(aiEditor)
      );
    },
  },
  reviewSelection: {
    icon: <MessageSquareTextIcon />,
    label: "Review selection",
    value: "reviewSelection",
    onSelect: ({ editor }) => {
      ignoreAiMenuPromise(
        editor.getApi(AIChatPlugin).aiChat.submit("", {
          mode: "chat",
          prompt:
            "Review the selection and identify the single most useful improvement",
          toolName: "comment",
        })
      );
    },
  },
  simplify: {
    icon: <FeatherIcon />,
    label: "Simplify language",
    value: "simplify",
    onSelect: ({ editor }) => {
      ignoreAiMenuPromise(
        editor
          .getApi(AIChatPlugin)
          .aiChat.submit("", {
            prompt: "Rewrite in simpler language",
            toolName: "edit",
          })
      );
    },
  },
  simplifyLanguage: {
    icon: <FeatherIcon />,
    label: "Simplify language",
    value: "simplifyLanguage",
    onSelect: ({ editor }) => {
      ignoreAiMenuPromise(
        editor.getApi(AIChatPlugin).aiChat.submit("", {
          prompt: "Simplify the language",
          toolName: "edit",
        })
      );
    },
  },
  summarize: {
    icon: <AlbumIcon />,
    label: "Add a summary",
    value: "summarize",
    onSelect: ({ editor }) => {
      ignoreAiMenuPromise(
        editor.getApi(AIChatPlugin).aiChat.submit("", {
          mode: "insert",
          prompt: {
            default: "Summarize {editor}",
            selecting: "Summarize",
          },
          toolName: "generate",
        })
      );
    },
  },
  summarizeDoc: {
    icon: <AlbumIcon />,
    label: "Summarize",
    value: "summarize",
    onSelect: ({ editor }) => {
      ignoreAiMenuPromise(
        editor.getApi(AIChatPlugin).aiChat.submit("", {
          prompt: { default: "Summarize {editor}", selecting: "Summarize" },
          toolName: "generate",
        })
      );
    },
  },
  toneCasual: {
    icon: <FeatherIcon />,
    label: "Change tone → Casual",
    value: "toneCasual",
    onSelect: ({ editor }) => {
      ignoreAiMenuPromise(
        editor
          .getApi(AIChatPlugin)
          .aiChat.submit("", {
            prompt: "Rewrite with a casual, friendly tone",
            toolName: "edit",
          })
      );
    },
  },
  toneProfessional: {
    icon: <FeatherIcon />,
    label: "Change tone → Professional",
    value: "toneProfessional",
    onSelect: ({ editor }) => {
      ignoreAiMenuPromise(
        editor
          .getApi(AIChatPlugin)
          .aiChat.submit("", {
            prompt: "Rewrite with a professional tone",
            toolName: "edit",
          })
      );
    },
  },
  tryAgain: {
    icon: <CornerUpLeftIcon />,
    label: "Try again",
    value: "tryAgain",
    onSelect: ({ editor }) => {
      emitQuality(editor, "retried");
      ignoreAiMenuPromise(editor.getApi(AIChatPlugin).aiChat.reload());
    },
  },
} satisfies Record<string, AIChatItemDefinition>;

const aiChatItemRegistry = aiChatItems as Record<string, AIChatItemDefinition>;

const menuStateItems = {
  commentSuggestion: [
    {
      items: [
        aiChatItems.addComment,
        aiChatItems.discard,
        aiChatItems.tryAgain,
      ],
    },
  ],
  cursorCommand: [
    {
      items: [
        aiChatItems.continueWrite,
        aiChatItems.summarize,
        aiChatItems.explain,
      ],
    },
  ],
  cursorSuggestion: [
    {
      items: [aiChatItems.accept, aiChatItems.discard, aiChatItems.tryAgain],
    },
  ],
  editSuggestion: [
    {
      items: [aiChatItems.accept, aiChatItems.discard, aiChatItems.tryAgain],
    },
  ],
  selectionCommand: [
    {
      items: [
        aiChatItems.improveWriting,
        aiChatItems.makeLonger,
        aiChatItems.makeShorter,
        aiChatItems.fixSpelling,
        aiChatItems.simplifyLanguage,
        aiChatItems.reviewSelection,
      ],
    },
    {
      items: [aiChatItems[GROUP.SELECTION_LANGUAGES]],
    },
  ],
  selectionSuggestion: [
    {
      items: [
        aiChatItems.replace,
        aiChatItems.insertBelow,
        aiChatItems.discard,
        aiChatItems.tryAgain,
      ],
    },
  ],
};

function AIMenuItems() {
  const editor = useEditorRef();
  const [searchValue] = useComboboxValueState();
  const { messages } = usePluginOption(AIChatPlugin, "chat");
  const aiEditor = usePluginOption(AIChatPlugin, "aiEditor");
  const toolName = usePluginOption(AIChatPlugin, "toolName");
  const isSelecting = useIsSelecting();

  const menuState = useMemo(() => {
    if (messages && messages.length > 0) {
      if (toolName === "comment") return "commentSuggestion";
      if (toolName === "edit") return "editSuggestion";
      return isSelecting ? "selectionSuggestion" : "cursorSuggestion";
    }

    return isSelecting ? "selectionCommand" : "cursorCommand";
  }, [isSelecting, messages, toolName]);

  const menuGroups = useMemo(() => {
    const items = menuStateItems[menuState] || [];

    return filterMenuGroups(items, searchValue) || items;
  }, [menuState, searchValue]);

  if (!aiEditor) {
    return null;
  }

  return (
    <>
      {menuGroups.map((group) => (
        <MenuGroup
          key={
            group.label ??
            group.items
              ?.map((item) => item.value ?? item.label ?? "menu-item")
              .join("-") ??
            "menu-group"
          }
          label={group.label}
        >
          {group.items?.map((item: Action) => {
            if (!item.value) {
              return null;
            }

            const menuItem = aiChatItemRegistry[item.value];

            if (menuItem.component) {
              const ItemComponent = menuItem.component;

              return <ItemComponent key={item.value} menuState={menuState} />;
            }

            return (
              <MenuItem
                icon={menuItem.icon}
                key={item.value}
                label={menuItem.label}
                onClick={() => menuItem.onSelect?.({ aiEditor, editor })}
                shortcutEnter
              />
            );
          })}
        </MenuGroup>
      ))}
    </>
  );
}

function TranslateMenuItems({ menuState }: { menuState: EditorChatState }) {
  const editor = useEditorRef();
  const [searchValue] = useComboboxValueState();

  const menuItems = useMemo(
    () => filterMenuItems(aiChatItems[GROUP.LANGUAGES], searchValue),
    [searchValue]
  );

  const handleTranslate = (value: string) => {
    if (menuState === "cursorCommand") {
      ignoreAiMenuPromise(
        editor.getApi(AIChatPlugin).aiChat.submit("", {
          mode: "insert",
          prompt: `Translate to ${value} the "Block" content`,
          toolName: "generate",
        })
      );

      return;
    }
    if (menuState === "selectionCommand") {
      ignoreAiMenuPromise(
        editor.getApi(AIChatPlugin).aiChat.submit("", {
          prompt: `Translate to ${value}`,
          toolName: "edit",
        })
      );

      return;
    }
  };

  const content = (
    <>
      {menuItems.map((item) => (
        <MenuItem
          icon={item.icon}
          key={item.value}
          label={item.label}
          onClick={() => {
            if (item.label) {
              handleTranslate(item.label);
            }
          }}
          shortcutEnter
        />
      ))}
    </>
  );

  if (searchValue)
    return (
      <MenuGroup label={aiChatItems[GROUP.LANGUAGES].label}>
        {content}
      </MenuGroup>
    );

  return (
    <Menu
      trigger={
        <MenuTrigger
          icon={aiChatItems[GROUP.LANGUAGES].icon}
          label={aiChatItems[GROUP.LANGUAGES].label}
        />
      }
    >
      <MenuContent variant="aiSub">
        <MenuGroup>{content}</MenuGroup>
      </MenuContent>
    </Menu>
  );
}

function AIMenuCombobox({
  input,
  setInput,
}: {
  input: string;
  setInput: (input: string) => void;
}) {
  const { api } = useEditorPlugin(AIChatPlugin);
  const [, setValue] = useComboboxValueState();

  useEffect(() => {
    setValue?.(input ?? "");
  }, [input, setValue]);

  return (
    <ComboboxInput autoFocus autoSelect="always">
      <TextareaAutosize
        className="grow"
        data-plate-focus
        onChange={(event) => setInput(event.target.value)}
        onKeyDown={(e) => {
          if (isHotkey("backspace")(e) && input?.length === 0) {
            e.preventDefault();
            api.aiChat.hide();
          }
          if (isHotkey("enter")(e) && !e.shiftKey) {
            e.preventDefault();

            if (input && input.length > 0) {
              ignoreAiMenuPromise(api.aiChat.submit(input));
              setInput("");
            }
          }
        }}
        placeholder="Ask AI anything..."
        variant="ai"
      />
    </ComboboxInput>
  );
}

function StopIcon() {
  return (
    <svg
      height="20"
      role="img"
      viewBox="0 0 20 20"
      width="20"
      xmlns="http://www.w3.org/2000/svg"
    >
      <title>Stop</title>
      <circle cx="10" cy="10" fill="black" r="10" />
      <rect fill="white" height="6" rx="1" width="6" x="7" y="7" />
    </svg>
  );
}

function SubmitIcon() {
  return (
    <div
      className={cn(
        "flex size-5 items-center justify-center rounded-full bg-primary"
      )}
    >
      <ArrowUpIcon className="size-3! stroke-[3px] text-background" />
    </div>
  );
}

function LoadingIcon() {
  return (
    <div className="flex gap-0.5">
      {["#eab308", "#ea580c", "#6EB6F2"].map((color, index) => (
        <div
          className="size-1 animate-ai-bounce rounded-full"
          key={color}
          style={{
            animationDelay: `${index * 0.1}s`,
            backgroundColor: color,
          }}
        />
      ))}
    </div>
  );
}
