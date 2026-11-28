import { AIChatPlugin } from "@platejs/ai/react";
import { KEYS } from "platejs";
import { createPlateEditor } from "platejs/react";

import { describe, expect, it } from "../../test/bun-test-compat";
import { createEditorKit } from "../components/create-editor-kit";
import {
  aiWriter,
  discardOwnAI,
  keepOwnAI,
  selectLastEditableEnd,
} from "./ai-ownership";

describe("discarding the AI's text", () => {
  it("removes this editor's AI text and keeps typed words and other writers' text", () => {
    const editor = createPlateEditor({ plugins: createEditorKit() });
    const aiBy = aiWriter(editor).id;
    editor.tf.setValue([
      {
        children: [{ text: "Mine." }, { ai: true, aiBy, text: " Added." }],
        type: "p",
      },
      { children: [{ ai: true, aiBy, text: "My AI paragraph." }], type: "p" },
      {
        children: [{ ai: true, aiBy: "someone-else", text: "Their preview." }],
        type: "p",
      },
      { children: [{ text: "Also mine." }], type: "p" },
    ]);

    discardOwnAI(editor);

    const texts = editor.children.map((_, index) => editor.api.string([index]));
    expect(texts.filter(Boolean).join("|")).toBe(
      "Mine.|Their preview.|Also mine."
    );
  });

  it("keeps accepted text through the discard that follows", () => {
    const editor = createPlateEditor({ plugins: createEditorKit() });
    const aiBy = aiWriter(editor).id;
    editor.tf.setValue([
      { children: [{ aiBy, text: "Accepted." }], type: "p" },
    ]);

    keepOwnAI(editor);
    discardOwnAI(editor);

    expect(JSON.stringify(editor.children)).toContain('"text":"Accepted."');
  });

  it("restores the caret to the end of the preceding non-void block even when selection was cleared", () => {
    const editor = createPlateEditor({ plugins: createEditorKit() });
    const aiBy = aiWriter(editor).id;
    editor.tf.setValue([
      { children: [{ text: "We shipped faster exports" }], type: "p" },
      { children: [{ ai: true, aiBy, text: "Scripted editor draft." }], type: "p" },
    ]);
    editor.tf.deselect();
    expect(editor.selection).toBeNull();

    discardOwnAI(editor);

    expect(editor.selection).toEqual({
      anchor: { offset: 25, path: [0, 0] },
      focus: { offset: 25, path: [0, 0] },
    });
    expect(editor.api.isAt({ end: true })).toBe(true);
  });

  it("skips a preceding void block when scanning backward after discarding an AI block", () => {
    const editor = createPlateEditor({ plugins: createEditorKit() });
    const aiBy = aiWriter(editor).id;
    editor.tf.setValue([
      { children: [{ text: "Before" }], type: "p" },
      { children: [{ text: "" }], type: "hr" },
      { children: [{ ai: true, aiBy, text: "Scripted editor draft." }], type: "p" },
    ]);
    editor.tf.select({
      anchor: { offset: 0, path: [2, 0] },
      focus: { offset: 0, path: [2, 0] },
    });

    discardOwnAI(editor);

    expect(editor.selection).toEqual({
      anchor: { offset: 6, path: [0, 0] },
      focus: { offset: 6, path: [0, 0] },
    });
  });

  it("skips both void blocks and transient aiChat anchor nodes when hiding and discarding", () => {
    const editor = createPlateEditor({ plugins: createEditorKit() });
    const aiBy = aiWriter(editor).id;
    const anchorType = editor.getType(KEYS.aiChat);
    editor.setOption(AIChatPlugin, "open", true);
    editor.tf.setValue([
      { children: [{ text: "" }], type: "hr" },
      { children: [{ ai: true, aiBy, text: "Scripted editor draft." }], type: "p" },
      { children: [{ text: "" }], type: anchorType },
      { children: [{ text: "Kept paragraph" }], type: "p" },
    ]);
    expect(editor.children.some((node) => node.type === anchorType)).toBe(true);
    editor.tf.select({
      anchor: { offset: 0, path: [1, 0] },
      focus: { offset: 0, path: [1, 0] },
    });

    editor.getApi(AIChatPlugin).aiChat.hide({ focus: false, undo: true });

    expect(editor.children.some((node) => node.type === anchorType)).toBe(false);
    expect(editor.selection).toEqual({
      anchor: { offset: 14, path: [1, 0] },
      focus: { offset: 14, path: [1, 0] },
    });
    expect(editor.api.string([1])).toBe("Kept paragraph");
  });

  it("selectLastEditableEnd skips trailing void and aiChat anchor blocks", () => {
    const editor = createPlateEditor({ plugins: createEditorKit() });
    const anchorType = editor.getType(KEYS.aiChat);
    editor.setOption(AIChatPlugin, "open", true);
    editor.tf.withoutNormalizing(() => {
      editor.children = [
        { children: [{ text: "Editable body" }], type: "p" },
        { children: [{ text: "" }], type: "hr" },
        { children: [{ text: "" }], type: anchorType },
      ];
    });
    editor.tf.deselect();
    expect(editor.children.map((node) => node.type)).toEqual([
      "p",
      "hr",
      anchorType,
    ]);

    expect(selectLastEditableEnd(editor)).toBe(true);
    expect(editor.selection).toEqual({
      anchor: { offset: 13, path: [0, 0] },
      focus: { offset: 13, path: [0, 0] },
    });
  });
});
