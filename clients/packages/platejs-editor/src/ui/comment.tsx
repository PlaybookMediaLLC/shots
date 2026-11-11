"use client";

import { getCommentKey, getDraftCommentKey } from "@platejs/comment";
import { CommentPlugin, useCommentId } from "@platejs/comment/react";
import {
  differenceInDays,
  differenceInHours,
  differenceInMinutes,
  format,
} from "date-fns";
import { ArrowUpIcon as ArrowUpIcon } from "@phosphor-icons/react/dist/ssr/ArrowUp"
import { CheckIcon as CheckIcon } from "@phosphor-icons/react/dist/ssr/Check"
import { DotsThreeIcon as MoreHorizontalIcon } from "@phosphor-icons/react/dist/ssr/DotsThree"
import { PencilIcon as PencilIcon } from "@phosphor-icons/react/dist/ssr/Pencil"
import { TrashIcon as TrashIcon } from "@phosphor-icons/react/dist/ssr/Trash"
import { XIcon as XIcon } from "@phosphor-icons/react/dist/ssr/X";
import { NodeApi, nanoid, type Value } from "platejs";
import {
  type CreatePlateEditorOptions,
  Plate,
  useEditorPlugin,
  useEditorRef,
  usePlateEditor,
  usePluginOption,
} from "platejs/react";
import React, {
  type DependencyList,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { cn } from "../lib/utils";
import { BasicMarksKit } from "../plugins/basic-marks-kit";
import { discussionPlugin, type TDiscussion } from "../plugins/discussion-kit";

import { Avatar, AvatarFallback, AvatarImage } from "./avatar";
import { Button } from "./button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./dropdown-menu";
import { Editor, EditorContainer } from "./editor";

export type TComment = {
  id: string;
  contentRich: Value;
  createdAt: Date;
  discussionId: string;
  isEdited: boolean;
  userId: string;
};

type CommentUpdateInput = Pick<
  TComment,
  "contentRich" | "discussionId" | "id" | "isEdited"
>;

export function Comment(props: {
  comment: TComment;
  discussionLength: number;
  editingId: string | null;
  index: number;
  setEditingId: React.Dispatch<React.SetStateAction<string | null>>;
  documentContent?: string;
  showDocumentContent?: boolean;
  onEditorClick?: () => void;
}) {
  const {
    comment,
    discussionLength,
    documentContent,
    editingId,
    index,
    setEditingId,
    showDocumentContent = false,
    onEditorClick,
  } = props;

  const editor = useEditorRef();

  const discussions = usePluginOption(discussionPlugin, "discussions");
  const userInfo = usePluginOption(discussionPlugin, "user", comment.userId);
  const currentUserId = usePluginOption(discussionPlugin, "currentUserId");

  const resolveDiscussion = (id: string) => {
    const updatedDiscussions = discussions.map((discussion) => {
      if (discussion.id === id) {
        return { ...discussion, isResolved: true };
      }

      return discussion;
    });
    editor.setOption(discussionPlugin, "discussions", updatedDiscussions);
  };

  const removeDiscussion = (id: string) => {
    const updatedDiscussions = discussions.filter(
      (discussion: TDiscussion) => discussion.id !== id
    );
    editor.setOption(discussionPlugin, "discussions", updatedDiscussions);
  };

  const updateComment = (input: CommentUpdateInput) => {
    const updatedDiscussions = discussions.map((discussion) => {
      if (discussion.id === input.discussionId) {
        const updatedComments = discussion.comments.map((discussionComment) => {
          if (discussionComment.id === input.id) {
            return {
              ...discussionComment,
              contentRich: input.contentRich,
              isEdited: input.isEdited,
              updatedAt: new Date(),
            };
          }

          return discussionComment;
        });

        return { ...discussion, comments: updatedComments };
      }

      return discussion;
    });
    editor.setOption(discussionPlugin, "discussions", updatedDiscussions);
  };

  const { tf } = useEditorPlugin(CommentPlugin);

  // Replace to your own backend or refer to potion
  const isMyComment = currentUserId === comment.userId;

  const initialValue = comment.contentRich;

  const commentEditor = useCommentEditor(
    {
      id: comment.id,
      value: initialValue,
    },
    [initialValue]
  );

  const onCancel = () => {
    setEditingId(null);
    commentEditor.tf.replaceNodes(initialValue, {
      at: [],
      children: true,
    });
  };

  const onSave = () => {
    updateComment({
      id: comment.id,
      contentRich: commentEditor.children,
      discussionId: comment.discussionId,
      isEdited: true,
    });
    setEditingId(null);
  };

  const onResolveComment = () => {
    resolveDiscussion(comment.discussionId);
    tf.comment.unsetMark({ id: comment.discussionId });
  };

  const isFirst = index === 0;
  const isLast = index === discussionLength - 1;
  const isEditing = editingId && editingId === comment.id;

  const [dropdownOpen, setDropdownOpen] = useState(false);

  return (
    <div className="group/comment">
      <div className="relative flex items-center">
        {userInfo && (
          <Avatar className="size-6">
            <AvatarImage alt={userInfo.name} src={userInfo.avatarUrl} />
            <AvatarFallback>{userInfo.name?.[0]}</AvatarFallback>
          </Avatar>
        )}
        <h4 className="mx-2 font-semibold text-sm leading-none">
          {/* Replace to your own backend or refer to potion */}
          {userInfo?.name}
        </h4>

        <div className="text-muted-foreground/80 text-xs leading-none">
          <span className="mr-1">
            {formatCommentDate(new Date(comment.createdAt))}
          </span>
          {comment.isEdited && <span>(edited)</span>}
        </div>

        {isMyComment && (
          <div
            className={cn(
              "absolute top-0 right-0 flex space-x-1 opacity-0 transition-opacity group-hover/comment:opacity-100",
              dropdownOpen && "opacity-100"
            )}
          >
            {index === 0 && (
              <Button
                className="h-6 p-1 text-muted-foreground"
                onClick={onResolveComment}
                type="button"
                variant="ghost"
              >
                <CheckIcon className="size-4" />
              </Button>
            )}

            <CommentMoreDropdown
              comment={comment}
              dropdownOpen={dropdownOpen}
              onCloseAutoFocus={() => {
                setTimeout(() => {
                  commentEditor.tf.focus({ edge: "endEditor" });
                }, 0);
              }}
              onRemoveComment={() => {
                if (discussionLength === 1) {
                  tf.comment.unsetMark({ id: comment.discussionId });
                  removeDiscussion(comment.discussionId);
                }
              }}
              setDropdownOpen={setDropdownOpen}
              setEditingId={setEditingId}
            />
          </div>
        )}
      </div>

      {isFirst && showDocumentContent && (
        <div className="relative mt-1 flex pl-[32px] text-sm text-muted-foreground">
          {discussionLength > 1 && (
            <div className="absolute top-[5px] left-3 h-full w-0.5 shrink-0 bg-muted" />
          )}
          <div className="my-px w-0.5 shrink-0 bg-primary" />
          {documentContent && <div className="ml-2">{documentContent}</div>}
        </div>
      )}

      <div className="relative my-1 pl-[26px]">
        {!isLast && (
          <div className="absolute top-0 left-3 h-full w-0.5 shrink-0 bg-muted" />
        )}
        <Plate editor={commentEditor} readOnly={!isEditing}>
          <EditorContainer variant="comment">
            <Editor
              className="w-auto grow"
              onClick={() => onEditorClick?.()}
              variant="comment"
            />

            {isEditing && (
              <div className="ml-auto flex shrink-0 gap-1">
                <Button
                  className="size-[28px]"
                  onClick={(e: React.MouseEvent<HTMLButtonElement>) => {
                    e.stopPropagation();
                    onCancel();
                  }}
                  size="icon"
                  variant="ghost"
                >
                  <div className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/40">
                    <XIcon className="!size-3 stroke-[3px] text-background" />
                  </div>
                </Button>

                <Button
                  onClick={(e: React.MouseEvent<HTMLButtonElement>) => {
                    e.stopPropagation();
                    onSave();
                  }}
                  size="icon"
                  variant="ghost"
                >
                  <div className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary">
                    <CheckIcon className="!size-3 stroke-[3px] text-background" />
                  </div>
                </Button>
              </div>
            )}
          </EditorContainer>
        </Plate>
      </div>
    </div>
  );
}

function CommentMoreDropdown(props: {
  comment: TComment;
  dropdownOpen: boolean;
  setDropdownOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setEditingId: React.Dispatch<React.SetStateAction<string | null>>;
  onCloseAutoFocus?: () => void;
  onRemoveComment?: () => void;
}) {
  const {
    comment,
    dropdownOpen,
    setDropdownOpen,
    setEditingId,
    onCloseAutoFocus,
    onRemoveComment,
  } = props;

  const discussions = usePluginOption(discussionPlugin, "discussions");
  const editor = useEditorRef();

  const selectedEditCommentRef = useRef(false);

  const onDeleteComment = React.useCallback(() => {
    if (!comment.id) return;

    // Find and update the discussion
    const updatedDiscussions = discussions.map((discussion: TDiscussion) => {
      if (discussion.id !== comment.discussionId) {
        return discussion;
      }

      const commentIndex = discussion.comments.findIndex(
        (discussionComment: TComment) => discussionComment.id === comment.id
      );

      if (commentIndex === -1) {
        return discussion;
      }

      return {
        ...discussion,
        comments: [
          ...discussion.comments.slice(0, commentIndex),
          ...discussion.comments.slice(commentIndex + 1),
        ],
      };
    });

    // Save back to session storage
    editor.setOption(discussionPlugin, "discussions", updatedDiscussions);
    onRemoveComment?.();
  }, [comment.discussionId, comment.id, discussions, editor, onRemoveComment]);

  const onEditComment = React.useCallback(() => {
    selectedEditCommentRef.current = true;

    if (!comment.id) return;

    setEditingId(comment.id);
  }, [comment.id, setEditingId]);

  return (
    <DropdownMenu
      modal={false}
      onOpenChange={setDropdownOpen}
      open={dropdownOpen}
    >
      <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
        <Button className={cn("h-6 p-1 text-muted-foreground")} variant="ghost">
          <MoreHorizontalIcon className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        className="w-48"
        onCloseAutoFocus={(e) => {
          if (selectedEditCommentRef.current) {
            onCloseAutoFocus?.();
            selectedEditCommentRef.current = false;
          }

          return e.preventDefault();
        }}
      >
        <DropdownMenuGroup>
          <DropdownMenuItem onClick={onEditComment}>
            <PencilIcon className="size-4" />
            Edit comment
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onDeleteComment}>
            <TrashIcon className="size-4" />
            Delete comment
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export const useCommentEditor = (
  options: Omit<CreatePlateEditorOptions, "plugins"> = {},
  deps: DependencyList = []
) => {
  const commentEditor = usePlateEditor(
    {
      id: "comment",
      plugins: BasicMarksKit,
      value: [],
      ...options,
    },
    deps
  );

  return commentEditor;
};

export function CommentCreateForm({
  autoFocus = false,
  className,
  discussionId: discussionIdProp,
  focusOnMount = false,
}: {
  autoFocus?: boolean;
  className?: string;
  discussionId?: string;
  focusOnMount?: boolean;
}) {
  const discussions = usePluginOption(discussionPlugin, "discussions");

  const editor = useEditorRef();
  const commentId = useCommentId();
  const discussionId = discussionIdProp ?? commentId;

  const userInfo = usePluginOption(discussionPlugin, "currentUser");
  const [commentValue, setCommentValue] = React.useState<Value | undefined>();
  const commentContent = useMemo(
    () => commentValue?.map((node) => NodeApi.string(node)).join("") ?? "",
    [commentValue]
  );
  const commentEditor = useCommentEditor();

  useEffect(() => {
    if (commentEditor && focusOnMount) {
      commentEditor.tf.focus();
    }
  }, [commentEditor, focusOnMount]);

  const onAddComment = React.useCallback(() => {
    if (!commentValue) return;

    commentEditor.tf.reset();

    // App extension point (RFC-162 Phase 5): a comment that mentions
    // @assistant is handed to the registered hook AFTER it lands, so the app
    // can thread an assistant answer under it. No hook, no behavior change.
    const notifyAssistantMention = (targetDiscussionId: string) => {
      const hook = (
        globalThis as {
          __canvasCommentAssistantHook?: (args: {
            discussionId: string;
            text: string;
          }) => void;
        }
      ).__canvasCommentAssistantHook;
      if (hook && /@assistant\b/i.test(commentContent)) {
        hook({ discussionId: targetDiscussionId, text: commentContent });
      }
    };

    if (discussionId) {
      // Get existing discussion
      const discussion = discussions.find(
        (existingDiscussion: TDiscussion) =>
          existingDiscussion.id === discussionId
      );

      if (!discussion) {
        // Mock creating suggestion
        const newDiscussion: TDiscussion = {
          id: discussionId,
          comments: [
            {
              id: nanoid(),
              contentRich: commentValue,
              createdAt: new Date(),
              discussionId,
              isEdited: false,
              userId: editor.getOption(discussionPlugin, "currentUserId"),
            },
          ],
          createdAt: new Date(),
          isResolved: false,
          userId: editor.getOption(discussionPlugin, "currentUserId"),
        };

        editor.setOption(discussionPlugin, "discussions", [
          ...discussions,
          newDiscussion,
        ]);

        notifyAssistantMention(discussionId);
        return;
      }

      // Create reply comment
      const comment: TComment = {
        id: nanoid(),
        contentRich: commentValue,
        createdAt: new Date(),
        discussionId,
        isEdited: false,
        userId: editor.getOption(discussionPlugin, "currentUserId"),
      };

      // Add reply to discussion comments
      const updatedDiscussion = {
        ...discussion,
        comments: [...discussion.comments, comment],
      };

      // Filter out old discussion and add updated one
      const updatedDiscussions = discussions
        .filter(
          (existingDiscussion: TDiscussion) =>
            existingDiscussion.id !== discussionId
        )
        .concat(updatedDiscussion);

      editor.setOption(discussionPlugin, "discussions", updatedDiscussions);

      notifyAssistantMention(discussionId);
      return;
    }

    const commentsNodeEntry = editor
      .getApi(CommentPlugin)
      .comment.nodes({ at: [], isDraft: true });

    if (commentsNodeEntry.length === 0) return;

    const documentContent = commentsNodeEntry
      .map(([node]) => node.text)
      .join("");

    const _discussionId = nanoid();
    // Mock creating new discussion
    const newDiscussion: TDiscussion = {
      id: _discussionId,
      comments: [
        {
          id: nanoid(),
          contentRich: commentValue,
          createdAt: new Date(),
          discussionId: _discussionId,
          isEdited: false,
          userId: editor.getOption(discussionPlugin, "currentUserId"),
        },
      ],
      createdAt: new Date(),
      documentContent,
      isResolved: false,
      userId: editor.getOption(discussionPlugin, "currentUserId"),
    };

    editor.setOption(discussionPlugin, "discussions", [
      ...discussions,
      newDiscussion,
    ]);

    const id = newDiscussion.id;

    commentsNodeEntry.forEach(([_, path]) => {
      editor.tf.setNodes(
        {
          [getCommentKey(id)]: true,
        },
        { at: path, split: true }
      );
      editor.tf.unsetNodes([getDraftCommentKey()], { at: path });
    });

    notifyAssistantMention(id);
  }, [
    commentValue,
    commentContent,
    commentEditor.tf,
    discussionId,
    editor,
    discussions,
  ]);

  return (
    <div className={cn("flex w-full", className)}>
      <div className="mt-1 mr-1 shrink-0">
        {/* Replace to your own backend or refer to potion */}
        <Avatar className="size-5">
          <AvatarImage alt={userInfo?.name} src={userInfo?.avatarUrl} />
          <AvatarFallback>{userInfo?.name?.[0]}</AvatarFallback>
        </Avatar>
      </div>

      <div className="relative flex grow gap-2">
        <Plate
          editor={commentEditor}
          onChange={({ value }) => {
            setCommentValue(value);
          }}
        >
          <EditorContainer variant="comment">
            <Editor
              autoComplete="off"
              autoFocus={autoFocus}
              className="min-h-[25px] grow pt-0.5 pr-8"
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  onAddComment();
                }
              }}
              placeholder="Reply..."
              variant="comment"
            />

            <Button
              aria-label="Send comment"
              className="absolute right-0 bottom-0 ml-auto size-6 shrink-0 rounded-full bg-foreground text-background hover:bg-foreground/85 hover:text-background disabled:bg-muted disabled:text-muted-foreground disabled:opacity-100"
              disabled={commentContent.trim().length === 0}
              onClick={(e) => {
                e.stopPropagation();
                onAddComment();
              }}
              size="icon"
              variant="ghost"
            >
              <ArrowUpIcon className="size-3.5" weight="bold" />
            </Button>
          </EditorContainer>
        </Plate>
      </div>
    </div>
  );
}

export const formatCommentDate = (date: Date) => {
  const now = new Date();
  const diffMinutes = differenceInMinutes(now, date);
  const diffHours = differenceInHours(now, date);
  const diffDays = differenceInDays(now, date);

  if (diffMinutes < 60) {
    return `${diffMinutes}m`;
  }
  if (diffHours < 24) {
    return `${diffHours}h`;
  }
  if (diffDays < 2) {
    return `${diffDays}d`;
  }

  return format(date, "MM/dd/yyyy");
};
