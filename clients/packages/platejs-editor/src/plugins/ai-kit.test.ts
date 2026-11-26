import { createPlateEditor } from "platejs/react";

import { describe, expect, it } from "../../test/bun-test-compat";
import { createEditorKit } from "../components/create-editor-kit";
import { aiWriter, discardOwnAI, keepOwnAI } from "./ai-ownership";

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
});
