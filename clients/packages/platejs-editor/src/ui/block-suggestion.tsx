"use client";

import type { TResolvedSuggestion } from "@platejs/suggestion";
import {
  acceptSuggestion,
  getSuggestionKey,
  keyId2SuggestionId,
  rejectSuggestion,
} from "@platejs/suggestion";
import { SuggestionPlugin } from "@platejs/suggestion/react";
import { CheckIcon as CheckIcon } from "@phosphor-icons/react/dist/ssr/Check"
import { XIcon as XIcon } from "@phosphor-icons/react/dist/ssr/X";
import {
  ElementApi,
  KEYS,
  type NodeEntry,
  type Path,
  PathApi,
  type TElement,
  TextApi,
  type TSuggestionElement,
  type TSuggestionText,
} from "platejs";
import { useEditorPlugin, usePluginOption } from "platejs/react";
import { Fragment, useEffect, useMemo, useState } from "react";

import { cn } from "../lib/utils";
import { discussionPlugin, type TDiscussion } from "../plugins/discussion-kit";
import { suggestionPlugin } from "../plugins/suggestion-kit";

import { Avatar, AvatarFallback, AvatarImage } from "./avatar";
import { Button } from "./button";
import {
  Comment,
  CommentCreateForm,
  formatCommentDate,
  type TComment,
} from "./comment";

export interface ResolvedSuggestion extends TResolvedSuggestion {
  comments: TComment[];
}

type SuggestionLineItem = {
  id: string;
  text: string;
};

export const BLOCK_SUGGESTION = "__block__";

export const TYPE_TEXT_MAP: Record<string, (node?: TElement) => string> = {
  [KEYS.audio]: () => "Audio",
  [KEYS.blockquote]: () => "Blockquote",
  [KEYS.callout]: () => "Callout",
  [KEYS.codeBlock]: () => "Code Block",
  [KEYS.column]: () => "Column",
  [KEYS.equation]: () => "Equation",
  [KEYS.file]: () => "File",
  [KEYS.h1]: () => "Heading 1",
  [KEYS.h2]: () => "Heading 2",
  [KEYS.h3]: () => "Heading 3",
  [KEYS.h4]: () => "Heading 4",
  [KEYS.h5]: () => "Heading 5",
  [KEYS.h6]: () => "Heading 6",
  [KEYS.hr]: () => "Horizontal Rule",
  [KEYS.img]: () => "Image",
  [KEYS.mediaEmbed]: () => "Media",
  [KEYS.p]: (node) => {
    if (node?.[KEYS.listType] === KEYS.listTodo) return "Todo List";
    if (node?.[KEYS.listType] === KEYS.ol) return "Ordered List";
    if (node?.[KEYS.listType] === KEYS.ul) return "List";

    return "Paragraph";
  },
  [KEYS.table]: () => "Table",
  [KEYS.toc]: () => "Table of Contents",
  [KEYS.toggle]: () => "Toggle",
  [KEYS.video]: () => "Video",
};

function suggestionTextToArray(text?: string | null): string[] {
  if (!text) {
    return [];
  }

  if (text === BLOCK_SUGGESTION) {
    return ["line breaks"];
  }

  return text.split(BLOCK_SUGGESTION).filter(Boolean);
}

function createSuggestionLineItems(
  prefix: string,
  values: string[]
): SuggestionLineItem[] {
  const valueCounts = new Map<string, number>();

  return values.map((value) => {
    const normalizedValue = value || "line breaks";
    const occurrence = (valueCounts.get(normalizedValue) ?? 0) + 1;
    valueCounts.set(normalizedValue, occurrence);

    return {
      id: `${prefix}-${normalizedValue}-${occurrence}`,
      text: normalizedValue,
    };
  });
}

export function BlockSuggestionCard({
  idx,
  isLast,
  suggestion,
}: {
  idx: number;
  isLast: boolean;
  suggestion: ResolvedSuggestion;
}) {
  const { api, editor } = useEditorPlugin(SuggestionPlugin);

  const userInfo = usePluginOption(discussionPlugin, "user", suggestion.userId);

  const insertItems = useMemo(
    () =>
      createSuggestionLineItems(
        `${suggestion.suggestionId}-insert`,
        suggestionTextToArray(suggestion.newText)
      ),
    [suggestion.newText, suggestion.suggestionId]
  );
  const removeItems = useMemo(
    () =>
      createSuggestionLineItems(
        `${suggestion.suggestionId}-remove`,
        suggestionTextToArray(suggestion.text)
      ),
    [suggestion.suggestionId, suggestion.text]
  );

  const accept = (resolvedSuggestion: ResolvedSuggestion) => {
    api.suggestion.withoutSuggestions(() => {
      acceptSuggestion(editor, resolvedSuggestion);
    });
  };

  const reject = (resolvedSuggestion: ResolvedSuggestion) => {
    api.suggestion.withoutSuggestions(() => {
      rejectSuggestion(editor, resolvedSuggestion);
    });
  };

  const [editingId, setEditingId] = useState<string | null>(null);

  return (
    <div className="group relative" data-suggestion-index={idx}>
      <div className="flex flex-col p-4">
        <div className="relative flex items-center">
          {/* Replace to your own backend or refer to potion */}
          {userInfo && (
            <Avatar className="size-6">
              <AvatarImage alt={userInfo.name} src={userInfo.avatarUrl} />
              <AvatarFallback>{userInfo.name?.[0]}</AvatarFallback>
            </Avatar>
          )}
          <h4 className="mx-2 font-semibold text-sm leading-none">
            {userInfo?.name}
          </h4>
          <div className="text-muted-foreground/80 text-xs leading-none">
            <span className="mr-1">
              {formatCommentDate(new Date(suggestion.createdAt))}
            </span>
          </div>
        </div>

        <div className="relative mt-1 mb-4 pl-[32px]">
          <div className="flex flex-col gap-2">
            {suggestion.type === "remove" &&
              removeItems.map((item) => (
                <div className="flex items-center gap-2" key={item.id}>
                  <span className="text-muted-foreground text-sm">Delete:</span>

                  <span className="text-sm">{item.text}</span>
                </div>
              ))}

            {suggestion.type === "insert" &&
              insertItems.map((item) => (
                <div className="flex items-center gap-2" key={item.id}>
                  <span className="text-muted-foreground text-sm">Add:</span>

                  <span className="text-sm">{item.text}</span>
                </div>
              ))}

            {suggestion.type === "replace" && (
              <div className="flex flex-col gap-2">
                {insertItems.map((item) => (
                  <Fragment key={item.id}>
                    <div className="flex items-center text-primary/80">
                      <span className="text-sm">With:</span>
                      <span className="text-sm">"{item.text}"</span>
                    </div>
                  </Fragment>
                ))}

                {removeItems.map((item, itemIndex) => (
                  <Fragment key={item.id}>
                    <div className="flex items-center">
                      <span className="text-muted-foreground text-sm">
                        {itemIndex === 0 ? "Replace:" : "Delete:"}
                      </span>
                      <span className="text-sm">"{item.text}"</span>
                    </div>
                  </Fragment>
                ))}
              </div>
            )}

            {suggestion.type === "update" && (
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground text-sm">
                  {Object.keys(suggestion.properties).map((key) => (
                    <span key={key}>Un{key}</span>
                  ))}

                  {Object.keys(suggestion.newProperties).map((key) => (
                    <span key={key}>
                      {key.charAt(0).toUpperCase() + key.slice(1)}
                    </span>
                  ))}
                </span>
                <span className="text-sm">"{suggestion.newText}"</span>
              </div>
            )}
          </div>
        </div>

        {suggestion.comments.map((comment, index) => (
          <Comment
            comment={comment}
            discussionLength={suggestion.comments.length}
            documentContent="__suggestion__"
            editingId={editingId}
            index={index}
            key={comment.id ?? index}
            setEditingId={setEditingId}
          />
        ))}

        <div className="pointer-events-none absolute top-4 right-4 flex gap-2 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100">
          <Button
            className="h-6 p-1 text-muted-foreground"
            onClick={() => accept(suggestion)}
            variant="ghost"
          >
            <CheckIcon className="size-4" />
          </Button>

          <Button
            className="h-6 p-1 text-muted-foreground"
            onClick={() => reject(suggestion)}
            variant="ghost"
          >
            <XIcon className="size-4" />
          </Button>
        </div>

        <CommentCreateForm discussionId={suggestion.suggestionId} />
      </div>

      {!isLast && <div className="h-px w-full bg-muted" />}
    </div>
  );
}

export const useResolveSuggestion = (
  suggestionNodes: NodeEntry<TElement | TSuggestionText>[],
  blockPath: Path
): ResolvedSuggestion[] => {
  const discussions = usePluginOption(discussionPlugin, "discussions");

  const { api, editor, getOption, setOption } =
    useEditorPlugin(suggestionPlugin);

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: path sync must reconcile overlapping inline and block suggestions
  useEffect(() => {
    for (const [node] of suggestionNodes) {
      const id = api.suggestion.nodeId(node);
      const map = getOption("uniquePathMap");

      if (!id) {
        continue;
      }

      const previousPath = map.get(id);

      // If there are no suggestion nodes in the corresponding path in the map, then update it.
      if (PathApi.isPath(previousPath)) {
        const nodes = api.suggestion.node({
          id,
          at: previousPath,
          isText: true,
        });
        const parentNode = api.node(previousPath);
        let lineBreakId: string | null = null;

        if (parentNode && ElementApi.isElement(parentNode[0])) {
          lineBreakId = api.suggestion.nodeId(parentNode[0]) ?? null;
        }
        if (!nodes && lineBreakId !== id) {
          setOption("uniquePathMap", new Map(map).set(id, blockPath));
        }

        continue;
      }

      setOption("uniquePathMap", new Map(map).set(id, blockPath));
    }
  }, [api, blockPath, getOption, setOption, suggestionNodes]);

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: suggestion resolution merges multiple node shapes into one UI model
  return useMemo(() => {
    const map = getOption("uniquePathMap");

    if (suggestionNodes.length === 0) {
      return [];
    }

    const suggestionIds = new Set<string>();

    for (const [node] of suggestionNodes) {
      if (TextApi.isText(node)) {
        const dataList = api.suggestion.dataList(node);
        const includeUpdate = dataList.some((data) => data.type === "update");

        if (!includeUpdate) {
          const nodeId = api.suggestion.nodeId(node);
          if (nodeId) {
            suggestionIds.add(nodeId);
          }
          continue;
        }

        for (const data of dataList) {
          if (data.type === "update" && data.id) {
            suggestionIds.add(data.id);
          }
        }

        continue;
      }

      if (ElementApi.isElement(node)) {
        const nodeId = api.suggestion.nodeId(node);
        if (nodeId) {
          suggestionIds.add(nodeId);
        }
      }
    }

    const res: ResolvedSuggestion[] = [];

    for (const id of suggestionIds) {
      const path = map.get(id);

      if (!(path && PathApi.isPath(path))) {
        continue;
      }
      if (!PathApi.equals(path, blockPath)) {
        continue;
      }

      const entries = [
        ...editor.api.nodes<TElement | TSuggestionText>({
          at: [],
          mode: "all",
          match: (n) =>
            (n[KEYS.suggestion] && n[getSuggestionKey(id)]) ||
            api.suggestion.nodeId(n as TElement) === id,
        }),
      ];

      // move line break to the end
      entries.sort(([, path1], [, path2]) =>
        PathApi.isChild(path1, path2) ? -1 : 1
      );

      let newText = "";
      let text = "";
      let properties: Record<string, unknown> = {};
      let newProperties: Record<string, unknown> = {};

      // overlapping suggestion
      for (const [node] of entries) {
        if (TextApi.isText(node)) {
          const dataList = api.suggestion.dataList(node);

          for (const data of dataList) {
            if (data.id !== id) {
              continue;
            }

            switch (data.type) {
              case "insert": {
                newText += node.text;

                break;
              }
              case "remove": {
                text += node.text;

                break;
              }
              case "update": {
                properties = {
                  ...properties,
                  ...data.properties,
                };

                newProperties = {
                  ...newProperties,
                  ...data.newProperties,
                };

                newText += node.text;

                break;
              }

              default:
                break;
            }
          }
        } else {
          const lineBreakData = api.suggestion.isBlockSuggestion(node)
            ? node.suggestion
            : undefined;

          if (lineBreakData?.id !== keyId2SuggestionId(id)) {
            continue;
          }
          if (lineBreakData.type === "insert") {
            newText += lineBreakData.isLineBreak
              ? BLOCK_SUGGESTION
              : BLOCK_SUGGESTION + TYPE_TEXT_MAP[node.type](node);
          } else if (lineBreakData.type === "remove") {
            text += lineBreakData.isLineBreak
              ? BLOCK_SUGGESTION
              : BLOCK_SUGGESTION + TYPE_TEXT_MAP[node.type](node);
          }
        }
      }

      if (entries.length === 0) {
        continue;
      }

      const nodeData = api.suggestion.suggestionData(entries[0][0]);

      if (!nodeData) {
        continue;
      }

      // const comments = data?.discussions.find((d) => d.id === id)?.comments;
      const comments =
        discussions.find((s: TDiscussion) => s.id === id)?.comments || [];
      const createdAt = new Date(nodeData.createdAt);

      const keyId = getSuggestionKey(id);

      if (nodeData.type === "update") {
        res.push({
          comments,
          createdAt,
          keyId,
          newProperties,
          newText,
          properties,
          suggestionId: keyId2SuggestionId(id),
          type: "update",
          userId: nodeData.userId,
        });
        continue;
      }
      if (newText.length > 0 && text.length > 0) {
        res.push({
          comments,
          createdAt,
          keyId,
          newText,
          suggestionId: keyId2SuggestionId(id),
          text,
          type: "replace",
          userId: nodeData.userId,
        });
        continue;
      }
      if (newText.length > 0) {
        res.push({
          comments,
          createdAt,
          keyId,
          newText,
          suggestionId: keyId2SuggestionId(id),
          type: "insert",
          userId: nodeData.userId,
        });
        continue;
      }
      if (text.length > 0) {
        res.push({
          comments,
          createdAt,
          keyId,
          suggestionId: keyId2SuggestionId(id),
          text,
          type: "remove",
          userId: nodeData.userId,
        });
      }
    }

    return res;
  }, [
    api.suggestion,
    blockPath,
    discussions,
    editor.api,
    getOption,
    suggestionNodes,
  ]);
};

export const isResolvedSuggestion = (
  suggestion: ResolvedSuggestion | TDiscussion
): suggestion is ResolvedSuggestion => "suggestionId" in suggestion;

export function BlockSuggestion({ element }: { element: TSuggestionElement }) {
  const suggestionData = element.suggestion;

  if (suggestionData?.isLineBreak) return null;

  const isRemove = suggestionData?.type === "remove";

  return (
    <div
      className={cn(
        "pointer-events-none absolute inset-0 z-1 border-2 border-primary/[0.8] transition-opacity",
        isRemove && "border-gray-300"
      )}
      contentEditable={false}
    />
  );
}
