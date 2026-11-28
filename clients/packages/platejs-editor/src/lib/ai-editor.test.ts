import { describe, expect, it } from "../../test/bun-test-compat";
import { captureReviewSelection } from "../components/use-chat";
import { filterAICommentMenuGroups, menuStateItems } from "../ui/ai-menu";
import {
  dispatchEditorAIComment,
  EDITOR_AI_COMMENT_EVENT,
  editorActionForTool,
  type EditorAICommentEventDetail,
  EditorProposalSchema,
  editorToolForAction,
  reviewSummaryMessage,
} from "./ai-editor";

describe("editor AI proposal contract", () => {
  it("maps the three editor actions to Plate tools", () => {
    expect(editorActionForTool("edit")).toBe("replace_selection");
    expect(editorActionForTool("generate")).toBe("insert_blocks");
    expect(editorActionForTool("comment")).toBe("add_comment");
    expect(editorToolForAction("add_comment")).toBe("comment");
  });

  it("rejects empty and oversized proposal content", () => {
    expect(
      EditorProposalSchema.safeParse({
        action: "replace_selection",
        content: "",
      }).success
    ).toBe(false);
    expect(
      EditorProposalSchema.safeParse({
        action: "insert_blocks",
        content: "x".repeat(20_001),
      }).success
    ).toBe(false);
  });

  it("reports whether a dispatched review comment actually attached", () => {
    const originalWindow = globalThis.window;
    const fakeWindow = new EventTarget();
    (globalThis as { window?: unknown }).window = fakeWindow;
    const attachedListener = (event: Event) => {
      const detail = (event as CustomEvent<EditorAICommentEventDetail>).detail;
      if (detail.content === "matched") detail.markAttached?.();
    };
    fakeWindow.addEventListener(EDITOR_AI_COMMENT_EVENT, attachedListener);
    try {
      expect(
        dispatchEditorAIComment({
          comment: "Tighten this.",
          content: "matched",
          editorId: "ed-1",
        })
      ).toBe(true);
      expect(
        dispatchEditorAIComment({
          comment: "Tighten this.",
          content: "missing",
          editorId: "ed-1",
        })
      ).toBe(false);
    } finally {
      fakeWindow.removeEventListener(EDITOR_AI_COMMENT_EVENT, attachedListener);
      (globalThis as { window?: unknown }).window = originalWindow;
    }
  });

  it("counts only attached comments in the review summary notice", () => {
    expect(reviewSummaryMessage(0, 0)).toBe(
      "The review found nothing to change."
    );
    expect(reviewSummaryMessage(1, 3)).toBe("The review added 1 comment.");
    expect(reviewSummaryMessage(2, 2)).toBe("The review added 2 comments.");
    expect(reviewSummaryMessage(0, 2)).toBe(
      "The review could not attach its comments to the text."
    );
  });

  it("captures review selection preferring ctx.selection and rejecting collapsed or invalid ranges", () => {
    const editorRange = {
      anchor: { offset: 0, path: [0, 0] },
      focus: { offset: 5, path: [0, 0] },
    };
    const ctxRange = {
      anchor: { offset: 0, path: [2, 0] },
      focus: { offset: 10, path: [2, 0] },
    };

    expect(
      captureReviewSelection(editorRange, { ctx: { selection: ctxRange } })
    ).toEqual(ctxRange);
    expect(captureReviewSelection(editorRange, {})).toEqual(editorRange);
    expect(
      captureReviewSelection(
        {
          anchor: { offset: 2, path: [0, 0] },
          focus: { offset: 2, path: [0, 0] },
        },
        {}
      )
    ).toBeNull();
    expect(
      captureReviewSelection(
        {
          anchor: { offset: -1, path: [0, 0] },
          focus: { offset: 4, path: [0, 0] },
        },
        {}
      )
    ).toBeNull();
    expect(
      captureReviewSelection(
        { anchor: { offset: 0, path: [] }, focus: { offset: 4, path: [0, 0] } },
        {}
      )
    ).toBeNull();
  });

  it("hides review and comment actions from real menu groups while keeping other actions", () => {
    const valuesOf = (
      groups: readonly { items: readonly { value: string }[] }[]
    ) => groups.flatMap((group) => group.items.map((item) => item.value));

    const cursorDisabled = valuesOf(
      filterAICommentMenuGroups(menuStateItems.cursorCommand, false)
    );
    expect(
      valuesOf(filterAICommentMenuGroups(menuStateItems.cursorCommand, true))
    ).toContain("reviewPost");
    expect(cursorDisabled).not.toContain("reviewPost");
    expect(cursorDisabled).toContain("continueWrite");

    const selectionDisabled = valuesOf(
      filterAICommentMenuGroups(menuStateItems.selectionCommand, false)
    );
    expect(
      valuesOf(filterAICommentMenuGroups(menuStateItems.selectionCommand, true))
    ).toContain("reviewSelection");
    expect(selectionDisabled).not.toContain("reviewSelection");
    expect(selectionDisabled).toContain("improveWriting");

    const commentDisabled = valuesOf(
      filterAICommentMenuGroups(menuStateItems.commentSuggestion, false)
    );
    expect(
      valuesOf(
        filterAICommentMenuGroups(menuStateItems.commentSuggestion, true)
      )
    ).toContain("addComment");
    expect(commentDisabled).not.toContain("addComment");
    expect(commentDisabled).toContain("discard");
    expect(commentDisabled).toContain("tryAgain");

    // A group containing only comment items is pruned completely.
    expect(
      filterAICommentMenuGroups([{ items: [{ value: "reviewPost" }] }], false)
        .length
    ).toBe(0);
  });
});
