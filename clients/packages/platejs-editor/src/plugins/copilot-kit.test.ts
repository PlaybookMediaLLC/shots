import { CopilotPlugin } from "@platejs/ai/react";
import type { Value } from "platejs";
import { createPlateEditor } from "platejs/react";

import { describe, expect, it } from "../../test/bun-test-compat";
import { CopilotKit } from "./copilot-kit";

function makeEditor(value: Value) {
  const editor = createPlateEditor({
    plugins: CopilotKit,
    value,
  });
  editor.setOption(CopilotPlugin, "completeOptions", {
    ...editor.getOptions(CopilotPlugin).completeOptions,
    api: "https://copilot.example/complete",
  });
  return editor;
}

describe("CopilotKit inline suggestions (#665, #666)", () => {
  it("uses a 1000ms debounce delay and gates autoTriggerQuery on api, empty block, trailing space, and active suggestion", () => {
    const editor = makeEditor([
      {
        children: [{ text: "We shipped faster exports " }],
        id: "p1",
        type: "p",
      },
    ]);
    editor.tf.select({ offset: 26, path: [0, 0] });

    expect(editor.getOptions(CopilotPlugin).debounceDelay).toBe(1000);
    expect(
      editor.getOptions(CopilotPlugin).autoTriggerQuery?.({ editor })
    ).toBe(true);

    // Active suggestion blocks re-triggering.
    editor.setOption(CopilotPlugin, "suggestionText", "already shown");
    expect(
      editor.getOptions(CopilotPlugin).autoTriggerQuery?.({ editor })
    ).toBe(false);
    editor.setOption(CopilotPlugin, "suggestionText", null);

    // Block not ending in space or empty block does not trigger.
    const noSpace = makeEditor([
      { children: [{ text: "No trailing space" }], id: "p1", type: "p" },
    ]);
    noSpace.tf.select({ offset: 17, path: [0, 0] });
    expect(
      noSpace.getOptions(CopilotPlugin).autoTriggerQuery?.({ editor: noSpace })
    ).toBe(false);

    const empty = makeEditor([
      { children: [{ text: "" }], id: "p1", type: "p" },
    ]);
    empty.tf.select({ offset: 0, path: [0, 0] });
    expect(
      empty.getOptions(CopilotPlugin).autoTriggerQuery?.({ editor: empty })
    ).toBe(false);

    // Turning off inline suggestions disables autoTriggerQuery immediately.
    editor.setOption(CopilotPlugin, "completeOptions", {
      ...editor.getOptions(CopilotPlugin).completeOptions,
      api: undefined,
    });
    expect(
      editor.getOptions(CopilotPlugin).autoTriggerQuery?.({ editor })
    ).toBe(false);
  });

  it("applies a completion when caret, block, and prompt still match", () => {
    const editor = makeEditor([
      {
        children: [{ text: "We shipped faster exports " }],
        id: "p1",
        type: "p",
      },
    ]);
    editor.tf.select({ offset: 26, path: [0, 0] });
    const prompt =
      editor.getOptions(CopilotPlugin).getPrompt?.({ editor }) ?? "";

    editor
      .getOptions(CopilotPlugin)
      .completeOptions?.onFinish?.(prompt, " and measure the result.");

    expect(editor.getOptions(CopilotPlugin).suggestionNodeId).toBe("p1");
    expect(editor.getOptions(CopilotPlugin).suggestionText).toBe(
      " and measure the result."
    );
  });

  it("attaches ghost text to the lowest nested block rather than its outer container", () => {
    const editor = makeEditor([
      {
        children: [
          {
            children: [{ text: "Quoted line " }],
            id: "inner_p",
            type: "p",
          },
        ],
        id: "outer_quote",
        type: "blockquote",
      },
    ]);
    editor.tf.select({ offset: 12, path: [0, 0, 0] });
    const prompt =
      editor.getOptions(CopilotPlugin).getPrompt?.({ editor }) ?? "";

    editor
      .getOptions(CopilotPlugin)
      .completeOptions?.onFinish?.(prompt, "continues.");

    expect(editor.getOptions(CopilotPlugin).suggestionNodeId).toBe("inner_p");
    expect(editor.getOptions(CopilotPlugin).suggestionText).toBe("continues.");
  });

  it("discards a late completion after the caret moves to another identical block", () => {
    // 4 identical paragraphs so p1 and p2 produce the exact same previous/current/next prompt.
    const editor = makeEditor([
      { children: [{ text: "Same text " }], id: "p0", type: "p" },
      { children: [{ text: "Same text " }], id: "p1", type: "p" },
      { children: [{ text: "Same text " }], id: "p2", type: "p" },
      { children: [{ text: "Same text " }], id: "p3", type: "p" },
    ]);
    editor.tf.select({ offset: 10, path: [1, 0] });
    const promptAtP1 =
      editor.getOptions(CopilotPlugin).getPrompt?.({ editor }) ?? "";

    // Move caret with shouldAbort=false so the snapshot survives and onFinish's own path/id guards run.
    editor.setOption(CopilotPlugin, "shouldAbort", false);
    editor.tf.select({ offset: 10, path: [2, 0] });
    editor.setOption(CopilotPlugin, "shouldAbort", true);

    editor
      .getOptions(CopilotPlugin)
      .completeOptions?.onFinish?.(promptAtP1, "after moving.");

    expect(editor.getOptions(CopilotPlugin).suggestionText).toBeNull();
    expect(editor.getOptions(CopilotPlugin).suggestionNodeId).toBeNull();
  });

  it("discards '0', markdown-only, mismatched-prompt, expanded-selection, and missing-id completions", () => {
    const editor = makeEditor([
      { children: [{ text: "We shipped " }], id: "p1", type: "p" },
    ]);
    editor.tf.select({ offset: 11, path: [0, 0] });

    // Sentinel "0" and markdown-only whitespace completions ("** **") are ignored.
    const pZero =
      editor.getOptions(CopilotPlugin).getPrompt?.({ editor }) ?? "";
    editor.getOptions(CopilotPlugin).completeOptions?.onFinish?.(pZero, "0");
    expect(editor.getOptions(CopilotPlugin).suggestionText).toBeNull();

    const pMarkdownBlank =
      editor.getOptions(CopilotPlugin).getPrompt?.({ editor }) ?? "";
    editor
      .getOptions(CopilotPlugin)
      .completeOptions?.onFinish?.(pMarkdownBlank, "** **");
    expect(editor.getOptions(CopilotPlugin).suggestionText).toBeNull();

    // Mismatched sentPrompt is rejected without wiping the newer snapshot.
    const livePrompt =
      editor.getOptions(CopilotPlugin).getPrompt?.({ editor }) ?? "";
    editor
      .getOptions(CopilotPlugin)
      .completeOptions?.onFinish?.("stale-earlier-prompt", "wrong answer.");
    expect(editor.getOptions(CopilotPlugin).suggestionText).toBeNull();
    editor
      .getOptions(CopilotPlugin)
      .completeOptions?.onFinish?.(livePrompt, "right answer.");
    expect(editor.getOptions(CopilotPlugin).suggestionText).toBe(
      "right answer."
    );
    editor.setOption(CopilotPlugin, "suggestionText", null);

    // Expanded selection rejects completion even if snapshot was preserved.
    const pExpanded =
      editor.getOptions(CopilotPlugin).getPrompt?.({ editor }) ?? "";
    editor.setOption(CopilotPlugin, "shouldAbort", false);
    editor.tf.select({
      anchor: { offset: 0, path: [0, 0] },
      focus: { offset: 11, path: [0, 0] },
    });
    editor.setOption(CopilotPlugin, "shouldAbort", true);
    editor
      .getOptions(CopilotPlugin)
      .completeOptions?.onFinish?.(pExpanded, "exports.");
    expect(editor.getOptions(CopilotPlugin).suggestionText).toBeNull();

    // Block without string id never produces a prompt or undefined suggestionNodeId.
    const noIdEditor = makeEditor([
      { children: [{ text: "No id block " }], type: "p" },
    ]);
    delete (noIdEditor.children[0] as { id?: unknown }).id;
    noIdEditor.tf.select({ offset: 12, path: [0, 0] });
    expect(
      noIdEditor.getOptions(CopilotPlugin).getPrompt?.({ editor: noIdEditor })
    ).toBe("");
  });

  it("discards a late completion after typing, moving off the end (even with shouldAbort=false), or blurring", () => {
    const editor = makeEditor([
      { children: [{ text: "We shipped " }], id: "p1", type: "p" },
    ]);
    editor.tf.select({ offset: 11, path: [0, 0] });
    const prompt =
      editor.getOptions(CopilotPlugin).getPrompt?.({ editor }) ?? "";

    // Text changes with shouldAbort=false still fail onFinish's selection/prompt guards.
    editor.setOption(CopilotPlugin, "shouldAbort", false);
    editor.tf.insertText("faster ");
    editor.setOption(CopilotPlugin, "shouldAbort", true);
    editor
      .getOptions(CopilotPlugin)
      .completeOptions?.onFinish?.(prompt, "today.");
    expect(editor.getOptions(CopilotPlugin).suggestionText).toBeNull();

    // Moving caret off the end with shouldAbort=false still fails isAt({ end: true }) guard.
    const midPrompt =
      editor.getOptions(CopilotPlugin).getPrompt?.({ editor }) ?? "";
    editor.setOption(CopilotPlugin, "shouldAbort", false);
    editor.tf.select({ offset: 3, path: [0, 0] });
    editor.setOption(CopilotPlugin, "shouldAbort", true);
    editor
      .getOptions(CopilotPlugin)
      .completeOptions?.onFinish?.(midPrompt, "today.");
    expect(editor.getOptions(CopilotPlugin).suggestionText).toBeNull();

    // Blur aborts in-flight request, clears active suggestion, and invalidates late onFinish.
    editor.tf.select({ offset: 18, path: [0, 0] });
    const blurPrompt =
      editor.getOptions(CopilotPlugin).getPrompt?.({ editor }) ?? "";
    const blurController = new AbortController();
    editor.setOption(CopilotPlugin, "abortController", blurController);
    editor.setOption(CopilotPlugin, "suggestionText", "visible ghost");
    editor.setOption(CopilotPlugin, "suggestionNodeId", "p1");
    const plugin = editor.getPlugin(CopilotPlugin);
    plugin.handlers.onBlur?.({ api: editor.api, editor } as never);
    expect(blurController.signal.aborted).toBe(true);
    expect(editor.getOptions(CopilotPlugin).suggestionText).toBeNull();
    expect(editor.getOptions(CopilotPlugin).suggestionNodeId).toBeNull();

    editor
      .getOptions(CopilotPlugin)
      .completeOptions?.onFinish?.(blurPrompt, "while blurred.");
    expect(editor.getOptions(CopilotPlugin).suggestionText).toBeNull();
  });

  it("discards a late completion if inline suggestions were turned off in flight", () => {
    const editor = makeEditor([
      { children: [{ text: "We shipped " }], id: "p1", type: "p" },
    ]);
    editor.tf.select({ offset: 11, path: [0, 0] });
    const prompt =
      editor.getOptions(CopilotPlugin).getPrompt?.({ editor }) ?? "";

    editor.setOption(CopilotPlugin, "completeOptions", {
      ...editor.getOptions(CopilotPlugin).completeOptions,
      api: undefined,
    });

    // Call onFinish BEFORE getPrompt so the in-flight snapshot is still present and api guard is exercised.
    editor
      .getOptions(CopilotPlugin)
      .completeOptions?.onFinish?.(prompt, "faster exports.");
    expect(editor.getOptions(CopilotPlugin).suggestionText).toBeNull();
    expect(editor.getOptions(CopilotPlugin).getPrompt?.({ editor })).toBe("");
  });

  it("aborts an in-flight copilot request on edits, caret moves, and mouse down (and clears suggestion)", () => {
    const editor = makeEditor([
      { children: [{ text: "We shipped " }], id: "p1", type: "p" },
    ]);
    editor.tf.select({ offset: 11, path: [0, 0] });

    const editController = new AbortController();
    editor.setOption(CopilotPlugin, "abortController", editController);
    editor.tf.insertText("x");
    expect(editController.signal.aborted).toBe(true);
    expect(editor.getOptions(CopilotPlugin).abortController).toBeNull();

    const moveController = new AbortController();
    editor.setOption(CopilotPlugin, "abortController", moveController);
    editor.tf.select({ offset: 2, path: [0, 0] });
    expect(moveController.signal.aborted).toBe(true);
    expect(editor.getOptions(CopilotPlugin).abortController).toBeNull();

    const mouseController = new AbortController();
    editor.setOption(CopilotPlugin, "abortController", mouseController);
    editor.setOption(CopilotPlugin, "suggestionText", "visible ghost");
    editor.setOption(CopilotPlugin, "suggestionNodeId", "p1");
    const plugin = editor.getPlugin(CopilotPlugin);
    plugin.handlers.onMouseDown?.({ api: editor.api, editor } as never);
    expect(mouseController.signal.aborted).toBe(true);
    expect(editor.getOptions(CopilotPlugin).suggestionText).toBeNull();
    expect(editor.getOptions(CopilotPlugin).suggestionNodeId).toBeNull();
  });
});
