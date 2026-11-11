"use client";

import { getDraftCommentKey } from "@platejs/comment";
import { CommentPlugin } from "@platejs/comment/react";
import { SuggestionPlugin } from "@platejs/suggestion/react";
import { ChatTextIcon as MessageSquareTextIcon } from "@phosphor-icons/react/dist/ssr/ChatText"
import { ChatsIcon as MessagesSquareIcon } from "@phosphor-icons/react/dist/ssr/Chats"
import { PencilLineIcon as PencilLineIcon } from "@phosphor-icons/react/dist/ssr/PencilLine";
import {
  type AnyPluginConfig,
  type NodeEntry,
  type Path,
  PathApi,
  type TCommentText,
  type TElement,
  TextApi,
  type TSuggestionText,
} from "platejs";
import type { PlateElementProps, RenderNodeWrapper } from "platejs/react";
import { useEditorPlugin, useEditorRef, usePluginOption } from "platejs/react";
import {
  Fragment,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { commentPlugin } from "../plugins/comment-kit";
import { discussionPlugin, type TDiscussion } from "../plugins/discussion-kit";
import { suggestionPlugin } from "../plugins/suggestion-kit";
import {
  BlockSuggestionCard,
  isResolvedSuggestion,
  useResolveSuggestion,
} from "./block-suggestion";
import { Button } from "./button";
import { Comment, CommentCreateForm } from "./comment";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverTrigger,
} from "./popover";

export const BlockDiscussion: RenderNodeWrapper<AnyPluginConfig> = (props) => {
  const isOverlapWithEditor = usePluginOption(
    commentPlugin,
    "isOverlapWithEditor"
  );

  if (!isOverlapWithEditor) return;

  const { api, editor, element } = props;

  const blockPath = editor.api.findPath(element);

  // avoid duplicate in table or column
  if (!blockPath || blockPath.length > 1) return;

  const draftCommentNode = api.comment.node({ at: blockPath, isDraft: true });

  const commentNodes = [...api.comment.nodes({ at: blockPath })];

  const suggestionNodes = [
    ...editor.getApi(SuggestionPlugin).suggestion.nodes({ at: blockPath }),
  ];

  if (
    commentNodes.length === 0 &&
    suggestionNodes.length === 0 &&
    !draftCommentNode
  ) {
    return;
  }

  return (discussionProps) => (
    <BlockCommentsContent
      blockPath={blockPath}
      commentNodes={commentNodes}
      draftCommentNode={draftCommentNode}
      suggestionNodes={suggestionNodes}
      {...discussionProps}
    />
  );
};

function resolveDiscussionAnchorElement({
  activeCommentId,
  activeSuggestion,
  commentNodes,
  draftCommentNode,
  editor,
  suggestionNodes,
}: {
  activeCommentId: string | null;
  activeSuggestion:
    ReturnType<typeof useResolveSuggestion>[number] | null | undefined;
  commentNodes: NodeEntry<TCommentText>[];
  draftCommentNode: NodeEntry<TCommentText> | undefined;
  editor: ReturnType<typeof useEditorRef>;
  suggestionNodes: NodeEntry<TElement | TSuggestionText>[];
}) {
  let activeNode: NodeEntry | undefined;

  if (activeSuggestion) {
    activeNode = suggestionNodes.find(
      ([node]) =>
        TextApi.isText(node) &&
        editor.getApi(SuggestionPlugin).suggestion.nodeId(node) ===
          activeSuggestion.suggestionId
    );
  }

  if (activeCommentId) {
    if (activeCommentId === getDraftCommentKey()) {
      activeNode = draftCommentNode;
    } else {
      activeNode = commentNodes.find(
        ([node]) =>
          editor.getApi(CommentPlugin).comment.nodeId(node) === activeCommentId
      );
    }
  }

  if (!activeNode) {
    return null;
  }

  return editor.api.toDOMNode(activeNode[0]) ?? null;
}

function renderDiscussionPopoverBody({
  activeDiscussion,
  activeSuggestion,
  isCommenting,
  noneActive,
  sortedMergedData,
}: {
  activeDiscussion: TDiscussion | null | undefined;
  activeSuggestion:
    ReturnType<typeof useResolveSuggestion>[number] | null | undefined;
  isCommenting: boolean;
  noneActive: boolean;
  sortedMergedData: Array<
    TDiscussion | ReturnType<typeof useResolveSuggestion>[number]
  >;
}): ReactNode {
  if (isCommenting) {
    return <CommentCreateForm className="p-3" focusOnMount />;
  }

  if (noneActive) {
    return sortedMergedData.map((item, index) =>
      isResolvedSuggestion(item) ? (
        <BlockSuggestionCard
          idx={index}
          isLast={index === sortedMergedData.length - 1}
          key={item.suggestionId}
          suggestion={item}
        />
      ) : (
        <BlockComment
          discussion={item}
          isLast={index === sortedMergedData.length - 1}
          key={item.id}
        />
      )
    );
  }

  return (
    <>
      {activeSuggestion && (
        <BlockSuggestionCard
          idx={0}
          isLast={true}
          key={activeSuggestion.suggestionId}
          suggestion={activeSuggestion}
        />
      )}

      {activeDiscussion && (
        <BlockComment discussion={activeDiscussion} isLast={true} />
      )}
    </>
  );
}

const BlockCommentsContent = ({
  blockPath,
  children,
  commentNodes,
  draftCommentNode,
  suggestionNodes,
}: PlateElementProps & {
  blockPath: Path;
  commentNodes: NodeEntry<TCommentText>[];
  draftCommentNode: NodeEntry<TCommentText> | undefined;
  suggestionNodes: NodeEntry<TElement | TSuggestionText>[];
}) => {
  const editor = useEditorRef();

  const resolvedSuggestion = useResolveSuggestion(suggestionNodes, blockPath);

  const resolvedDiscussions = useResolvedDiscussion(commentNodes, blockPath);

  const suggestionsCount = resolvedSuggestion.length;
  const discussionsCount = resolvedDiscussions.length;
  const totalCount = suggestionsCount + discussionsCount;

  const activeSuggestionId = usePluginOption(suggestionPlugin, "activeId");
  const activeSuggestion = activeSuggestionId
    ? resolvedSuggestion.find((s) => s.suggestionId === activeSuggestionId)
    : undefined;

  const commentingBlock = usePluginOption(commentPlugin, "commentingBlock");
  const activeCommentId = usePluginOption(commentPlugin, "activeId");
  const isCommenting = activeCommentId === getDraftCommentKey();
  const activeDiscussion = activeCommentId
    ? resolvedDiscussions.find((d) => d.id === activeCommentId)
    : undefined;

  const noneActive = !(activeSuggestion || activeDiscussion);

  const sortedMergedData = [...resolvedDiscussions, ...resolvedSuggestion].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime()
  );

  const selected =
    resolvedDiscussions.some((d) => d.id === activeCommentId) ||
    resolvedSuggestion.some((s) => s.suggestionId === activeSuggestionId);

  const [_open, setOpen] = useState(selected);
  const blockRef = useRef<HTMLDivElement>(null);

  // in some cases, we may comment the multiple blocks
  const commentingCurrent =
    !!commentingBlock && PathApi.equals(blockPath, commentingBlock);

  const open =
    _open ||
    selected ||
    (isCommenting && !!draftCommentNode && commentingCurrent);

  const anchorElement = useMemo(() => {
    return resolveDiscussionAnchorElement({
      activeCommentId,
      activeSuggestion,
      commentNodes,
      draftCommentNode,
      editor,
      suggestionNodes,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    activeSuggestion,
    activeCommentId,
    editor.api,
    editor,
    suggestionNodes,
    draftCommentNode,
    commentNodes,
  ]);

  if (suggestionsCount + resolvedDiscussions.length === 0 && !draftCommentNode)
    return <div className="w-full">{children}</div>;

  const popoverBody = renderDiscussionPopoverBody({
    activeDiscussion,
    activeSuggestion,
    isCommenting,
    noneActive,
    sortedMergedData,
  });

  return (
    <div className="flex w-full justify-between">
      <Popover
        onOpenChange={(_open_) => {
          if (!_open_ && isCommenting && draftCommentNode) {
            editor.tf.unsetNodes(getDraftCommentKey(), {
              at: [],
              mode: "lowest",
              match: (n) => n[getDraftCommentKey()],
            });
          }

          setOpen(_open_);
        }}
        open={open}
      >
        <div className="w-full" ref={blockRef}>
          {children}
        </div>
        {/* Measured when the popover places itself: the commented text while
            it is in the page, else its block. A leaf the editor re-rendered
            measures as the window's corner. */}
        <PopoverAnchor
          virtualRef={{
            current: {
              getBoundingClientRect: () =>
                (anchorElement?.isConnected
                  ? anchorElement
                  : blockRef.current
                )?.getBoundingClientRect() ?? new DOMRect(),
            },
          }}
        />

        <PopoverContent
          align="center"
          // Flat, with a hairline: it reads as part of the editor, not a layer over it.
          // The host app's popover rule is unlayered, so only an important utility removes its shadow.
          className="max-h-[min(50dvh,calc(-24px+var(--radix-popper-available-height)))] w-[380px] min-w-[130px] max-w-[calc(100vw-24px)] overflow-y-auto p-0 shadow-none! data-[state=closed]:opacity-0"
          onCloseAutoFocus={(e) => e.preventDefault()}
          onOpenAutoFocus={(e) => e.preventDefault()}
          side="bottom"
        >
          {popoverBody}
        </PopoverContent>

        {totalCount > 0 && (
          <div className="relative left-0 size-0 select-none">
            <PopoverTrigger asChild>
              <Button
                className="mt-1 ml-1 flex h-6 gap-1 px-1.5 py-0 text-muted-foreground/80 hover:text-muted-foreground/80 data-[active=true]:bg-muted"
                contentEditable={false}
                data-active={open}
                variant="ghost"
              >
                {suggestionsCount > 0 && discussionsCount === 0 && (
                  <PencilLineIcon className="size-4 shrink-0" />
                )}

                {suggestionsCount === 0 && discussionsCount > 0 && (
                  <MessageSquareTextIcon className="size-4 shrink-0" />
                )}

                {suggestionsCount > 0 && discussionsCount > 0 && (
                  <MessagesSquareIcon className="size-4 shrink-0" />
                )}

                <span className="font-semibold text-xs">{totalCount}</span>
              </Button>
            </PopoverTrigger>
          </div>
        )}
      </Popover>
    </div>
  );
};

function BlockComment({
  discussion,
  isLast,
}: {
  discussion: TDiscussion;
  isLast: boolean;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);

  return (
    <Fragment key={discussion.id}>
      <div className="p-4">
        {discussion.comments.map((comment, index) => (
          <Comment
            comment={comment}
            discussionLength={discussion.comments.length}
            documentContent={discussion?.documentContent}
            editingId={editingId}
            index={index}
            key={comment.id ?? index}
            setEditingId={setEditingId}
            showDocumentContent
          />
        ))}
        <CommentCreateForm discussionId={discussion.id} />
      </div>

      {!isLast && <div className="h-px w-full bg-muted" />}
    </Fragment>
  );
}

const useResolvedDiscussion = (
  commentNodes: NodeEntry<TCommentText>[],
  blockPath: Path
): TDiscussion[] => {
  const { api, getOption, setOption } = useEditorPlugin(commentPlugin);

  const discussions = usePluginOption(discussionPlugin, "discussions");
  const commentsPathMap = usePluginOption(commentPlugin, "uniquePathMap");

  useEffect(() => {
    commentNodes.forEach(([node]) => {
      const id = api.comment.nodeId(node);
      const map = getOption("uniquePathMap");

      if (!id) return;

      const previousPath = map.get(id);

      // If there are no comment nodes in the corresponding path in the map, then update it.
      if (PathApi.isPath(previousPath)) {
        const nodes = api.comment.node({ id, at: previousPath });

        if (!nodes) {
          setOption("uniquePathMap", new Map(map).set(id, blockPath));

          return;
        }

        return;
      }

      setOption("uniquePathMap", new Map(map).set(id, blockPath));
    });
  }, [api, blockPath, commentNodes, getOption, setOption]);

  const commentsIds = new Set(
    commentNodes.map(([node]) => api.comment.nodeId(node)).filter(Boolean)
  );

  return discussions
    .map((d: TDiscussion) => ({
      ...d,
      createdAt: new Date(d.createdAt),
    }))
    .filter((item: TDiscussion) => {
      /** If comment cross blocks just show it in the first block */
      const firstBlockPath = commentsPathMap.get(item.id);

      if (!firstBlockPath) return false;
      if (!PathApi.equals(firstBlockPath, blockPath)) return false;

      return (
        api.comment.has({ id: item.id }) &&
        commentsIds.has(item.id) &&
        !item.isResolved
      );
    });
};
