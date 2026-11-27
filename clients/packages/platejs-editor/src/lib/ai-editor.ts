import { z } from "zod";

export const EDITOR_AI_COMMENT_EVENT = "platejs:ai-comment";
export const EDITOR_AI_QUALITY_EVENT = "platejs:ai-quality";

export const EditorProposalActionSchema = z.enum([
  "replace_selection",
  "insert_blocks",
  "add_comment",
]);

export const EditorProposalSchema = z.object({
  action: EditorProposalActionSchema,
  content: z.string().trim().min(1).max(20_000),
});

/** One streamed review comment (`data-comment`). */
export const EditorReviewCommentSchema = z.object({
  comment: z.string().trim().min(1),
  content: z.string().trim().min(1),
});

export const EditorToolNameSchema = z.enum(["comment", "edit", "generate"]);

export type EditorProposal = z.infer<typeof EditorProposalSchema>;
export type EditorProposalAction = z.infer<typeof EditorProposalActionSchema>;
export type EditorToolName = z.infer<typeof EditorToolNameSchema>;

export type EditorAICommentEventDetail = {
  comment: string;
  /** The passage the comment is about; without it, the current selection. */
  content?: string;
  editorId: string;
};

export type EditorAIQualityEventDetail = {
  action: EditorProposalAction | null;
  durationMs?: number;
  event:
    | "accepted"
    | "discarded"
    | "failed"
    | "finished"
    | "retried"
    | "started"
    | "stopped";
  mode: "chat" | "insert";
};

const ACTION_BY_TOOL: Record<EditorToolName, EditorProposalAction> = {
  comment: "add_comment",
  edit: "replace_selection",
  generate: "insert_blocks",
};

const TOOL_BY_ACTION: Record<EditorProposalAction, EditorToolName> = {
  add_comment: "comment",
  insert_blocks: "generate",
  replace_selection: "edit",
};

export const editorActionForTool = (
  toolName: EditorToolName | null
): EditorProposalAction | null => (toolName ? ACTION_BY_TOOL[toolName] : null);

export const editorToolForAction = (
  action: EditorProposalAction
): EditorToolName => TOOL_BY_ACTION[action];

export const dispatchEditorAIComment = (
  detail: EditorAICommentEventDetail
): void => {
  window.dispatchEvent(
    new CustomEvent<EditorAICommentEventDetail>(EDITOR_AI_COMMENT_EVENT, {
      detail,
    })
  );
};

export const dispatchEditorAIQuality = (
  detail: EditorAIQualityEventDetail
): void => {
  window.dispatchEvent(
    new CustomEvent<EditorAIQualityEventDetail>(EDITOR_AI_QUALITY_EVENT, {
      detail,
    })
  );
};
