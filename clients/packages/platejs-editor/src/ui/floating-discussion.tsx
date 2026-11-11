"use client";

import { getDraftCommentKey } from "@platejs/comment";
import { BlockSelectionPlugin } from "@platejs/selection/react";
import {
  acceptSuggestion,
  getSuggestionKey,
  keyId2SuggestionId,
  rejectSuggestion,
} from "@platejs/suggestion";
import { CheckIcon as CheckIcon } from "@phosphor-icons/react/dist/ssr/Check"
import { PencilLineIcon as PencilLineIcon } from "@phosphor-icons/react/dist/ssr/PencilLine"
import { XIcon as XIcon } from "@phosphor-icons/react/dist/ssr/X";
import {
  ElementApi,
  KEYS,
  type Node,
  NodeApi,
  type NodeEntry,
  PathApi,
  type SlateEditor,
  type TCommentText,
  type TElement,
  TextApi,
  type TSuggestionText,
} from "platejs";
import {
  type PlateEditor,
  useEditorContainerRef,
  useEditorMounted,
  useEditorPlugin,
  useEditorRef,
  useEditorSelector,
  useEditorVersion,
  usePluginOption,
} from "platejs/react";
import React, { useEffect, useReducer, useRef, useState } from "react";
import { useDebouncedCallback } from "../hooks/use-debounce-callback";
import { cn } from "../lib/utils";
import { commentPlugin } from "../plugins/comment-kit";
import { discussionPlugin, type TDiscussion } from "../plugins/discussion-kit";
import { suggestionPlugin } from "../plugins/suggestion-kit";
import { Avatar, AvatarFallback, AvatarImage } from "./avatar";
import {
  BLOCK_SUGGESTION,
  type ResolvedSuggestion,
  TYPE_TEXT_MAP,
} from "./block-suggestion";
import { Button } from "./button";
import { Comment, CommentCreateForm, formatCommentDate } from "./comment";

const FLOATING_PANEL_GAP = 10;

type SuggestionLineItem = {
  id: string;
  text: string;
};

function getSuggestionLineItems(
  prefix: string,
  value?: string | null
): SuggestionLineItem[] {
  if (!value) {
    return [];
  }

  const parts =
    value === BLOCK_SUGGESTION
      ? ["line breaks"]
      : value.split(BLOCK_SUGGESTION).filter(Boolean);
  const counts = new Map<string, number>();

  return parts.map((part) => {
    const normalizedPart = part || "line breaks";
    const occurrence = (counts.get(normalizedPart) ?? 0) + 1;
    counts.set(normalizedPart, occurrence);

    return {
      id: `${prefix}-${normalizedPart}-${occurrence}`,
      text: normalizedPart,
    };
  });
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: suggestion discovery merges inline and block suggestions into a stable floating sidebar map.
function buildSuggestionEntriesMap(
  editor: PlateEditor,
  suggestionApi: ReturnType<PlateEditor["getApi"]>
) {
  const nextEntriesMap: Record<
    string,
    NodeEntry<TElement | TSuggestionText>[]
  > = {};
  const allSuggestionNodes = suggestionApi.suggestion.nodes({ at: [] });
  const suggestionIds = new Set<string>();

  for (const [node] of allSuggestionNodes) {
    if (TextApi.isText(node)) {
      const dataList = suggestionApi.suggestion.dataList(node);
      const includeUpdate = dataList.some(
        (data: { type?: string }) => data.type === "update"
      );

      if (!includeUpdate) {
        const nodeId = suggestionApi.suggestion.nodeId(node);

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
      const nodeId = suggestionApi.suggestion.nodeId(node);

      if (nodeId) {
        suggestionIds.add(nodeId);
      }
    }
  }

  for (const id of suggestionIds) {
    const entries = [
      ...editor.api.nodes<TElement | TSuggestionText>({
        at: [],
        mode: "all",
        match: (n) =>
          (n[KEYS.suggestion] && n[getSuggestionKey(id)]) ||
          suggestionApi.suggestion.nodeId(n as TElement) === id,
      }),
    ];

    nextEntriesMap[id] = entries;
  }

  return nextEntriesMap;
}

export function FloatingDiscussion() {
  const mounted = useEditorMounted();
  const isOverlapWithEditor = usePluginOption(
    commentPlugin,
    "isOverlapWithEditor"
  );

  if (!mounted || isOverlapWithEditor) return null;

  return <FloatingDiscussionContent />;
}

const getCommentTop = (
  editor: SlateEditor,
  {
    node,
    relativeElement,
    topOffset = 30,
  }: {
    node: TCommentText | TElement | TSuggestionText;
    relativeElement: HTMLDivElement;
    topOffset?: number;
  }
) => {
  const commentLeafDomNode = editor.api.toDOMNode(node);

  if (!commentLeafDomNode) return 0;

  const relativeElementRect = relativeElement.getBoundingClientRect();
  const scrollTop = relativeElement.scrollTop;
  const commentLeafRect = commentLeafDomNode.getBoundingClientRect();

  const top = commentLeafRect.top - relativeElementRect.top + scrollTop;

  return top > topOffset ? top - topOffset : 0;
};

const updateActiveBelow = (
  topMap: Record<string, number>,
  domMap: Record<string, HTMLDivElement | null>,
  activeId: string
) => {
  const discussionArray = Object.entries(topMap)
    .map(([id, top]) => ({ id, top }))
    .sort((a, b) => a.top - b.top);

  const activeIndex = discussionArray.findIndex(({ id }) => id === activeId);

  if (activeIndex === -1 || activeIndex === discussionArray.length - 1)
    return topMap;

  const activeElement = discussionArray[activeIndex];
  const start = activeElement.top;
  const end = start + (domMap[activeId]?.clientHeight ?? 100);

  const nextElement = discussionArray[activeIndex + 1];
  const nextStart = nextElement.top;

  // Check if next element overlaps with active element
  if (nextStart <= end) {
    // Move all following elements down
    const offset = end - nextStart + 10; // Add 10px gap

    for (let i = activeIndex + 1; i < discussionArray.length; i++) {
      discussionArray[i].top += offset;
    }

    return Object.fromEntries(discussionArray.map((d) => [d.id, d.top]));
  }

  return topMap;
};

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: active floating cards need collision-aware repositioning in both directions.
function updateActiveTop(
  topMap: Record<string, number>,
  domMap: Record<string, HTMLDivElement | null>,
  activeId: string,
  targetTop: number
) {
  const discussionArray = Object.entries(topMap)
    .map(([id, top]) => ({ id, top }))
    .sort((a, b) => a.top - b.top);

  const index = discussionArray.findIndex(({ id }) => id === activeId);

  if (index === -1) return topMap;

  const currentTop = discussionArray[index].top;
  const diff = targetTop - currentTop;

  // Set position of active element
  discussionArray[index].top = targetTop;

  if (diff < 0) {
    // Moving up - check for overlaps with previous elements
    for (let i = index - 1; i >= 0; i--) {
      const currentElement = discussionArray[i];
      const nextElement = discussionArray[i + 1];
      const elementHeight = domMap[currentElement.id]?.clientHeight ?? 100;

      // Check if current element overlaps with next element
      if (
        currentElement.top + elementHeight + FLOATING_PANEL_GAP >
        nextElement.top
      ) {
        // Move current element up to avoid overlap
        currentElement.top =
          nextElement.top - elementHeight - FLOATING_PANEL_GAP;
      } else {
        break; // No more overlaps
      }
    }
  } else {
    // Moving down - check for overlaps with next elements
    const activeHeight = domMap[activeId]?.clientHeight ?? 100;
    let activeBottom = targetTop + activeHeight + FLOATING_PANEL_GAP;

    // Only move elements that would overlap with active element
    for (let i = index + 1; i < discussionArray.length; i++) {
      if (discussionArray[i].top < activeBottom) {
        discussionArray[i].top = activeBottom;
        activeBottom =
          discussionArray[i].top +
          (domMap[discussionArray[i].id]?.clientHeight ?? 100) +
          FLOATING_PANEL_GAP;
      } else {
        break; // No more overlaps
      }
    }
  }

  return Object.fromEntries(discussionArray.map((d) => [d.id, d.top]));
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: draft comment layout needs to rebalance panels above and below the active draft.
function updateTopCommenting(
  topMap: Record<string, number>,
  domMap: Record<string, HTMLDivElement | null>
) {
  const discussionArray = Object.entries(topMap)
    .map(([id, topDistance]) => ({ id, topDistance }))
    .sort((a, b) => a.topDistance - b.topDistance);

  const index = discussionArray.findIndex(
    ({ id }) => id === getDraftCommentKey()
  );

  if (index === -1) return topMap;

  const targetTopDistance = discussionArray[index].topDistance;

  // Find if any elements need to move up or down
  let moveDistance = 0;

  for (let i = 0; i < discussionArray.length; i++) {
    const current = discussionArray[i];
    const currentHeight = domMap[current.id]?.clientHeight ?? 100;

    if (i < index) {
      // Check if element needs to move up
      const minRequiredSpace =
        targetTopDistance - (currentHeight + FLOATING_PANEL_GAP);

      if (current.topDistance > minRequiredSpace) {
        const distance = current.topDistance - minRequiredSpace;
        moveDistance = Math.max(moveDistance, distance);
      }
    }
  }

  // Move elements up if needed
  if (moveDistance > 0) {
    for (let i = 0; i < index; i++) {
      discussionArray[i].topDistance -= moveDistance;
    }
  }

  // Check if next element overlaps with current element
  const currentHeight = domMap[discussionArray[index].id]?.clientHeight ?? 100;
  const currentBottom = targetTopDistance + currentHeight + FLOATING_PANEL_GAP;

  if (index + 1 < discussionArray.length) {
    const nextElement = discussionArray[index + 1];

    if (nextElement.topDistance < currentBottom) {
      // Only move elements that overlap
      let currentTop = currentBottom;

      for (let i = index + 1; i < discussionArray.length; i++) {
        const element = discussionArray[i];

        if (element.topDistance < currentTop) {
          element.topDistance = currentTop;
          const elementHeight = domMap[element.id]?.clientHeight ?? 100;
          currentTop += elementHeight + FLOATING_PANEL_GAP;
        } else {
          break; // No more overlaps
        }
      }
    }
  }

  return Object.fromEntries(discussionArray.map((d) => [d.id, d.topDistance]));
}

const resolveOverlappingTop = (
  topMap: Record<string, number>,
  domMap: Record<string, HTMLDivElement | null>
) => {
  const discussionArray = Object.entries(topMap)
    .map(([id, topDistance]) => ({ id, topDistance }))
    .sort((a, b) => a.topDistance - b.topDistance);

  // Iterate through each discussion from top to bottom, checking for overlap with previous discussions
  for (let i = 1; i < discussionArray.length; i++) {
    const currentDiscussion = discussionArray[i];
    const currentElement = domMap[currentDiscussion.id];

    if (!currentElement) continue;

    // Calculate the range of current discussion
    const currentStart = currentDiscussion.topDistance;
    const currentEnd = currentStart + currentElement.clientHeight;

    // Check for overlap with all previous discussions
    for (let j = 0; j < i; j++) {
      const previousDiscussion = discussionArray[j];
      const previousElement = domMap[previousDiscussion.id];

      if (!previousElement) continue;

      const previousStart = previousDiscussion.topDistance;
      const previousEnd = previousStart + previousElement.clientHeight;

      // Check for overlap: condition for two intervals overlapping
      if (
        (currentStart <= previousEnd && currentEnd >= previousStart) ||
        (previousStart <= currentEnd && previousEnd >= currentStart)
      ) {
        // If overlapping, move current discussion below the previous one
        currentDiscussion.topDistance = previousEnd + FLOATING_PANEL_GAP;
        // Update current discussion range and check for overlaps again
        i -= 1;

        break;
      }
    }
  }

  return Object.fromEntries(discussionArray.map((d) => [d.id, d.topDistance]));
};

const useCommentingNode = () =>
  useEditorSelector((editor) => {
    if (!editor.selection || editor.api.isExpanded()) return;

    return editor.api.node<TCommentText>({
      match: (n) =>
        TextApi.isText(n) && n[KEYS.comment] && n[getDraftCommentKey()],
    })?.[0];
  }, []);

function FloatingDiscussionContent() {
  const editorContainerRef = useEditorContainerRef();
  const editor = useEditorRef();
  const commentApi = editor.getApi(commentPlugin);
  const suggestionApi = editor.getApi(suggestionPlugin);

  const activeCommentId = usePluginOption(commentPlugin, "activeId");
  const activeSuggestionId = usePluginOption(suggestionPlugin, "activeId");
  const activeId = activeCommentId ?? activeSuggestionId;
  const isOverlapWithEditor = usePluginOption(
    commentPlugin,
    "isOverlapWithEditor"
  );
  const updateTimestamp = usePluginOption(commentPlugin, "updateTimestamp");

  const discussions = usePluginOption(discussionPlugin, "discussions");
  const domRef = React.useRef<Record<string, HTMLDivElement | null>>({});
  const topRef = React.useRef<Record<string, number>>({});

  const [, forceUpdate] = useReducer((x) => x + 1, 0);

  const commentingNode = useCommentingNode();
  const _version = useEditorVersion();

  const suggestionEntriesMap = useRef<
    Record<string, NodeEntry<TElement | TSuggestionText>[]>
  >({});

  useEffect(() => {
    suggestionEntriesMap.current = buildSuggestionEntriesMap(
      editor,
      suggestionApi
    );
  }, [editor, suggestionApi]);

  const suggestionList = Object.entries(suggestionEntriesMap.current).map(
    ([id, entries]) => ({
      id,
      entries,
    })
  );

  const renderFloatingDiscussion = React.useCallback(() => {
    if (isOverlapWithEditor) return;
    const relativeElement = editorContainerRef.current;

    if (!relativeElement) return;

    // Keep the open create form's place: this runs debounced after edits and
    // would otherwise send the form back off screen.
    topRef.current = {
      [getDraftCommentKey()]: topRef.current[getDraftCommentKey()],
    };

    discussions.forEach((discussion) => {
      if (
        discussion.isResolved ||
        !commentApi.comment.has({ id: discussion.id })
      )
        return;

      const commentLeafEntry = commentApi.comment.node({
        id: discussion.id,
        at: [],
      });

      if (!commentLeafEntry) return;

      const commentLeaf = commentLeafEntry[0];

      const topDistance = getCommentTop(editor, {
        node: commentLeaf,
        relativeElement,
      });

      topRef.current[discussion.id] = topDistance;
    });

    suggestionList.forEach(({ id, entries }) => {
      if (!id) return;

      const topDistance = getCommentTop(editor, {
        node: entries[0][0],
        relativeElement,
      });
      topRef.current[id] = topDistance;
    });

    topRef.current = resolveOverlappingTop(topRef.current, domRef.current);
    forceUpdate();

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    editorContainerRef,
    isOverlapWithEditor,
    commentApi.comment.has,
    commentApi.comment.node,
    discussions.forEach,
    editor,
    suggestionList.forEach,
  ]);

  const renderFloatingCreateForm = React.useCallback(() => {
    if (!commentingNode || activeId !== getDraftCommentKey()) return;
    const relativeElement = editorContainerRef.current;

    if (!relativeElement) return;

    const topDistance = getCommentTop(editor, {
      node: commentingNode,
      relativeElement,
    });

    topRef.current[getDraftCommentKey()] = topDistance;

    topRef.current = updateTopCommenting(topRef.current, domRef.current);

    forceUpdate();
  }, [activeId, commentingNode, editor, editorContainerRef]);

  const debouncedUpdateFloat = useDebouncedCallback(
    renderFloatingDiscussion,
    500
  );

  useEffect(() => {
    if (updateTimestamp) {
      debouncedUpdateFloat();
    }
  }, [debouncedUpdateFloat, updateTimestamp]);

  useEffect(() => {
    if (!discussions) return;

    setTimeout(() => {
      renderFloatingDiscussion();
    }, 0);
  }, [discussions, renderFloatingDiscussion]);

  useEffect(() => {
    if (!(activeId && domRef.current[activeId])) return;

    const resizeObserver = new ResizeObserver(() => {
      topRef.current = updateActiveBelow(
        topRef.current,
        domRef.current,
        activeId
      );

      forceUpdate();
    });
    resizeObserver.observe(domRef.current[activeId]);

    return () => {
      resizeObserver.disconnect();
    };
  }, [activeId]);

  useEffect(() => {
    if (!activeId) {
      return renderFloatingDiscussion();
    }
    const relativeElement = editorContainerRef.current;

    const activeNode = commentApi.comment.node({ id: activeId, at: [] });
    const activeSuggestionNode = suggestionApi.suggestion.node({
      id: activeId,
      at: [],
      isText: true,
    });

    if (!(relativeElement && (activeNode || activeSuggestionNode))) return;

    topRef.current = updateActiveTop(
      topRef.current,
      domRef.current,
      activeId,
      getCommentTop(editor, {
        // biome-ignore lint/suspicious/noExplicitAny: complex type
        node: (activeNode?.[0] || activeSuggestionNode?.[0]) as any,
        relativeElement,
      })
    );

    forceUpdate();
  }, [
    activeId,
    editor,
    editorContainerRef,
    renderFloatingDiscussion,
    commentApi.comment,
    suggestionApi.suggestion,
  ]);

  useEffect(() => {
    const draftCommentElement = domRef.current[getDraftCommentKey()];

    if (!(commentingNode && draftCommentElement)) {
      return;
    }

    const resizeObserver = new ResizeObserver(() => {
      renderFloatingCreateForm();
    });
    resizeObserver.observe(draftCommentElement);

    return () => {
      resizeObserver.disconnect();
    };
  }, [commentingNode, renderFloatingCreateForm]);

  useEffect(() => {
    if (!isOverlapWithEditor) {
      renderFloatingDiscussion();
    }
  }, [isOverlapWithEditor, renderFloatingDiscussion]);

  return (
    <>
      {/* Unsubmit comment */}
      {commentingNode && (
        <div
          className="absolute right-[80px] w-[288px] cursor-pointer rounded-xl border border-border bg-popover p-3 transition-transform duration-200"
          ref={(el) => {
            domRef.current[getDraftCommentKey()] = el;
          }}
          style={{
            top: topRef.current[getDraftCommentKey()] ?? -9999,
          }}
        >
          <CommentCreateForm focusOnMount />
        </div>
      )}

      {discussions.map(
        (discussion) =>
          !discussion.isResolved &&
          commentApi.comment.has({ id: discussion.id }) && (
            <FloatingCommentsContent
              discussion={discussion}
              domRef={domRef}
              key={discussion.id}
              ref={(el) => {
                domRef.current[discussion.id] = el;
              }}
              top={topRef.current[discussion.id] ?? 0}
            />
          )
      )}

      {suggestionList.map(
        ({ id, entries }) =>
          id && (
            <FloatingSuggestionContent
              entries={entries}
              id={id}
              key={id}
              ref={(el) => {
                domRef.current[id] = el;
              }}
              top={topRef.current[id] ?? 0}
            />
          )
      )}
    </>
  );
}

type FloatingCommentsContentProps = {
  discussion: TDiscussion;
  domRef: React.RefObject<Record<string, HTMLDivElement | null>>;
  top: number;
};

function FloatingCommentsContent({
  discussion,
  ref,
  top,
}: React.ComponentProps<"div"> & FloatingCommentsContentProps) {
  const editor = useEditorRef();

  const activeId = usePluginOption(commentPlugin, "activeId");

  const [editingId, setEditingId] = React.useState<string | null>(null);

  const highlightDiscussion = (
    targetEditor: PlateEditor,
    discussionId: string
  ) => {
    targetEditor.setOption(commentPlugin, "activeId", discussionId);
    targetEditor.setOption(suggestionPlugin, "activeId", null);
    const leaf = targetEditor.api.node({
      at: [],
      match: (n) =>
        TextApi.isText(n) &&
        n[KEYS.comment] &&
        targetEditor.getApi(commentPlugin).comment.nodeId(n) === discussionId,
    });

    if (!leaf) return;

    const parent = NodeApi.get<Node>(targetEditor, leaf[1].slice(0, 1));

    targetEditor
      .getApi(BlockSelectionPlugin)
      .blockSelection.addSelectedRow(parent?.id as string, {
        clear: false,
        delay: 1000,
      });
  };

  const lastComment = discussion.comments.at(-1);

  return (
    <div
      className={cn(
        "absolute right-20 z-10 w-72 animate-fade-in rounded-md border bg-popover p-3 transition-transform duration-200",
        "[&[data-active=true]]:-translate-x-2"
      )}
      data-active={activeId === discussion.id}
      data-discussion-id={discussion.id}
      ref={ref}
      style={{
        top,
      }}
    >
      {discussion.comments.length >= 3 &&
      activeId !== discussion.id &&
      lastComment ? (
        <>
          <Comment
            comment={discussion.comments[0]}
            discussionLength={discussion.comments.length}
            documentContent={discussion?.documentContent}
            editingId={editingId}
            index={0}
            key={discussion.comments[0].id}
            onEditorClick={() => highlightDiscussion(editor, discussion.id)}
            setEditingId={setEditingId}
          />
          <div className="relative mb-1 ml-[26px] flex h-7 items-center rounded-md pl-1.5 text-muted-foreground text-sm hover:bg-muted">
            <div className="absolute top-[-5px] left-[-14px] h-full w-0.5 shrink-0 bg-muted" />
            <div className="ml-2">
              Show {discussion.comments.length - 2} replies
            </div>
          </div>
          <Comment
            comment={lastComment}
            discussionLength={discussion.comments.length}
            documentContent={discussion?.documentContent}
            editingId={editingId}
            index={discussion.comments.length - 1}
            key={lastComment.id}
            onEditorClick={() => highlightDiscussion(editor, discussion.id)}
            setEditingId={setEditingId}
          />
        </>
      ) : (
        discussion.comments.map((comment, index) => (
          <Comment
            comment={comment}
            discussionLength={discussion.comments.length}
            documentContent={discussion?.documentContent}
            editingId={editingId}
            index={index}
            key={comment.id ?? index}
            onEditorClick={() => highlightDiscussion(editor, discussion.id)}
            setEditingId={setEditingId}
          />
        ))
      )}

      {activeId === discussion.id && (
        <CommentCreateForm discussionId={discussion.id} />
      )}
    </div>
  );
}

type FloatingSuggestionContentProps = {
  id: string;
  entries: NodeEntry<TElement | TSuggestionText>[];
  top: number;
};

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: suggestion cards combine hover state, selection state, and multi-shape diff rendering in one UI surface.
function FloatingSuggestionContent({
  id,
  entries,
  ref,
  top,
}: React.ComponentProps<"div"> & FloatingSuggestionContentProps) {
  const { api, editor, setOption } = useEditorPlugin(suggestionPlugin);
  const nodeData = api.suggestion.suggestionData(entries[0][0]);

  const activeId = usePluginOption(suggestionPlugin, "activeId");

  const userId = usePluginOption(discussionPlugin, "currentUserId");
  const userData = usePluginOption(discussionPlugin, "user", userId);
  const discussions = usePluginOption(discussionPlugin, "discussions");

  const [editingId, setEditingId] = useState<string | null>(null);

  if (entries.length === 0) return null;

  // move line break to the end
  entries.sort(([, path1], [, path2]) =>
    PathApi.isChild(path1, path2) ? -1 : 1
  );

  let newText = "";
  let removedText = "";
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
            removedText += node.text;

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
          default: {
            break;
          }
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
        removedText += lineBreakData.isLineBreak
          ? BLOCK_SUGGESTION
          : BLOCK_SUGGESTION + TYPE_TEXT_MAP[node.type](node);
      }
    }
  }

  if (!nodeData) return null;

  const comments = discussions.find((d) => d.id === id)?.comments || [];
  const createdAt = new Date(nodeData.createdAt);
  const keyId = getSuggestionKey(id);

  const removeItems = getSuggestionLineItems(`${id}-remove`, removedText);
  const insertItems = getSuggestionLineItems(`${id}-insert`, newText);

  const acceptResolvedSuggestion = (resolvedSuggestion: ResolvedSuggestion) => {
    api.suggestion.withoutSuggestions(() => {
      acceptSuggestion(editor, resolvedSuggestion);
    });
  };

  const rejectResolvedSuggestion = (resolvedSuggestion: ResolvedSuggestion) => {
    api.suggestion.withoutSuggestions(() => {
      rejectSuggestion(editor, resolvedSuggestion);
    });
  };

  let suggestion: ResolvedSuggestion;

  if (nodeData.type === "update") {
    suggestion = {
      comments,
      createdAt,
      keyId,
      newProperties,
      newText,
      properties,
      suggestionId: keyId2SuggestionId(id),
      type: "update",
      userId: nodeData.userId,
    };
  } else if (newText.length > 0 && removedText.length > 0) {
    suggestion = {
      comments,
      createdAt,
      keyId,
      newText,
      suggestionId: keyId2SuggestionId(id),
      text: removedText,
      type: "replace",
      userId: nodeData.userId,
    };
  } else if (newText.length > 0) {
    suggestion = {
      comments,
      createdAt,
      keyId,
      newText,
      suggestionId: keyId2SuggestionId(id),
      type: "insert",
      userId: nodeData.userId,
    };
  } else if (removedText.length > 0) {
    suggestion = {
      comments,
      createdAt,
      keyId,
      suggestionId: keyId2SuggestionId(id),
      text: removedText,
      type: "remove",
      userId: nodeData.userId,
    };
  } else {
    return null;
  }

  const highlightSuggestion = (
    targetEditor: PlateEditor,
    suggestionId: string
  ) => {
    targetEditor.setOption(suggestionPlugin, "activeId", suggestionId);
    targetEditor.setOption(commentPlugin, "activeId", null);

    const leaf = targetEditor.api.node({
      at: [],
      match: (n) =>
        n[KEYS.suggestion] &&
        targetEditor
          .getApi(suggestionPlugin)
          .suggestion.nodeId(n as TElement | TSuggestionText) === suggestionId,
    });

    if (!leaf) return;

    const parent = NodeApi.get<Node>(targetEditor, leaf[1].slice(0, 1));

    targetEditor
      .getApi(BlockSelectionPlugin)
      .blockSelection.addSelectedRow(parent?.id as string, {
        clear: false,
        delay: 1000,
      });
  };

  const lastSuggestionComment = suggestion.comments.at(-1);

  return (
    <div
      className={cn(
        "group absolute right-20 z-10 w-72 animate-fade-in rounded-md border bg-popover p-3 transition-transform duration-200 hover:-translate-x-2 hover:bg-muted",
        "[&[data-active=true]]:-translate-x-2"
      )}
      data-active={activeId === id}
      data-discussion-id={id}
      ref={ref}
      style={{ top }}
    >
      <div className="flex flex-col">
        <button
          className="relative flex items-center text-left"
          onBlur={() => setOption("hoverId", null)}
          onClick={() => highlightSuggestion(editor, id)}
          onFocus={() => setOption("hoverId", id)}
          onMouseEnter={() => setOption("hoverId", id)}
          onMouseLeave={() => setOption("hoverId", null)}
          type="button"
        >
          {userData && (
            <>
              <Avatar className="relative mr-2 size-6">
                <AvatarImage alt={userData.name} src={userData.avatarUrl} />
                <AvatarFallback>{userData.name?.[0]}</AvatarFallback>
              </Avatar>
              <PencilLineIcon className="absolute -bottom-2 left-4 size-4 rounded-full bg-brand-foreground p-0.5 text-primary/80" />
            </>
          )}
          <h4 className="font-semibold text-sm leading-none">
            {userData?.name}
          </h4>
          <div className="ml-1.5 text-muted-foreground/80 text-xs leading-none">
            <span className="mr-1">
              {formatCommentDate(suggestion.createdAt)}
            </span>
          </div>
        </button>

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
                  <span className="text-sm">"{item.text}"</span>
                </div>
              ))}

            {suggestion.type === "replace" && (
              <div className="flex flex-col gap-2">
                {insertItems.map((item) => (
                  <React.Fragment key={item.id}>
                    <div className="flex items-center text-primary/80">
                      <span className="text-sm">With:</span>
                      <span className="text-sm">"{item.text}"</span>
                    </div>
                  </React.Fragment>
                ))}

                {removeItems.map((item, itemIndex) => (
                  <React.Fragment key={item.id}>
                    <div className="flex items-center">
                      <span className="text-muted-foreground text-sm">
                        {itemIndex === 0 ? "Replace:" : "Delete:"}
                      </span>
                      <span className="text-sm">"{item.text}"</span>
                    </div>
                  </React.Fragment>
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

        {suggestion.comments.length >= 3 &&
        activeId !== id &&
        lastSuggestionComment ? (
          <>
            <Comment
              comment={suggestion.comments[0]}
              discussionLength={suggestion.comments.length}
              documentContent="__suggestion__"
              editingId={editingId}
              index={0}
              key={suggestion.comments[0].id}
              setEditingId={setEditingId}
            />
            <div className="relative mb-1 ml-[26px] flex h-7 items-center rounded-md pl-1.5 text-muted-foreground text-sm hover:bg-muted">
              <div className="absolute top-[-5px] left-[-14px] h-full w-0.5 shrink-0 bg-muted" />
              <div className="ml-2">
                Show {suggestion.comments.length - 2} replies
              </div>
            </div>
            <Comment
              comment={lastSuggestionComment}
              discussionLength={suggestion.comments.length}
              documentContent="__suggestion__"
              editingId={editingId}
              index={suggestion.comments.length - 1}
              key={lastSuggestionComment.id}
              setEditingId={setEditingId}
            />
          </>
        ) : (
          suggestion.comments.map((comment, index) => (
            <Comment
              comment={comment}
              discussionLength={suggestion.comments.length}
              documentContent="__suggestion__"
              editingId={editingId}
              index={index}
              key={comment.id ?? index}
              setEditingId={setEditingId}
            />
          ))
        )}

        <div className="pointer-events-none absolute top-4 right-4 flex gap-2 opacity-0 transition-opacity group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100">
          <Button
            className="h-6 p-1 text-muted-foreground"
            onClick={() => acceptResolvedSuggestion(suggestion)}
            variant="ghost"
          >
            <CheckIcon className="size-4" />
          </Button>
          <Button
            className="h-6 p-1 text-muted-foreground"
            onClick={() => rejectResolvedSuggestion(suggestion)}
            variant="ghost"
          >
            <XIcon className="size-4" />
          </Button>
        </div>

        {activeId === id && (
          <CommentCreateForm discussionId={suggestion.suggestionId} />
        )}
      </div>
    </div>
  );
}
