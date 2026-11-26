import { createPlateEditor } from "platejs/react";

import { describe, expect, it } from "../../test/bun-test-compat";
import { createEditorKit } from "../components/create-editor-kit";

describe("discarding the AI's text", () => {
  it("removes only what the AI wrote and keeps the writer's words", () => {
    const editor = createPlateEditor({
      plugins: createEditorKit(),
      value: [
        { children: [{ text: "Mine." }, { ai: true, text: " Added." }], type: "p" },
        { children: [{ ai: true, text: "A whole AI paragraph." }], type: "p" },
        { children: [{ text: "Also mine." }], type: "p" },
      ],
    });

    (editor.tf as unknown as { ai: { undo: () => void } }).ai.undo();

    const texts = editor.children.map((_, index) => editor.api.string([index]));
    expect(texts.filter(Boolean).join("|")).toBe("Mine.|Also mine.");
  });
});
