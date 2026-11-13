import "../../test/dom";
import { BlockSelectionPlugin } from "@platejs/selection/react";
import { KEYS } from "platejs";
import {
  createPlateEditor,
  Plate,
  type PlateEditor,
  type PlateProps,
} from "platejs/react";
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "../../test/bun-test-compat";
import {
  createEditorKit,
  type EditorRecipe,
} from "../components/create-editor-kit";
import { BlockMenu } from "./block-menu";
import { FloatingToolbarButtons } from "./floating-toolbar-buttons";
import { slashItems } from "./slash-node";
import { Toolbar } from "./toolbar";

// "full" loads the AI chat and comment plugins, "collaborative" (Write's
// recipe) only comments, and "writing" neither.
const full = createPlateEditor({ plugins: createEditorKit() });
const collaborative = createPlateEditor({
  plugins: createEditorKit({ recipe: "collaborative" }),
});
const writing = createPlateEditor({
  plugins: createEditorKit({ recipe: "writing" }),
});

/** Renders `ui` in `editor`'s Plate and returns the name (aria-label, else text) of each `selector` match. */
async function rendered(editor: PlateEditor, ui: ReactNode, selector: string) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  // `ui` goes in as the children argument, which PlateProps' types do not count.
  const props = { editor } as PlateProps;
  await act(async () => root.render(createElement(Plate, props, ui)));
  // The block menu renders in a portal under <body>.
  const texts = [...document.body.querySelectorAll(selector)].map(
    (node) => node.getAttribute("aria-label") ?? node.textContent?.trim() ?? ""
  );
  await act(async () => root.unmount());
  container.remove();
  return texts;
}

const blockMenuOptions = (editor: PlateEditor) =>
  rendered(editor, createElement(BlockMenu, { open: true }), '[role="option"]');

/** The block menu for a selected image, which offers the media items. */
async function mediaMenuOptions(recipe: EditorRecipe) {
  const editor = createPlateEditor({
    plugins: createEditorKit({ recipe }),
    value: [{ children: [{ text: "" }], id: "image", type: KEYS.img, url: "" }],
  });
  editor.setOption(BlockSelectionPlugin, "selectedIds", new Set(["image"]));
  return blockMenuOptions(editor);
}

const toolbarButtons = (editor: PlateEditor) =>
  rendered(
    editor,
    createElement(Toolbar, null, createElement(FloatingToolbarButtons)),
    "button"
  );

const slashGroups = (editor: PlateEditor) =>
  slashItems
    .filter((group) => !group.when || group.when(editor))
    .map((group) => group.group);

// The toolbar's Ask AI is named by its tooltip.
const ASK_AI_BUTTON = "Edit, generate, and more";

const has = (texts: string[], prefix: string) =>
  texts.some((text) => text.startsWith(prefix));

describe("entries that call an optional plugin's API", () => {
  it("are left out of an editor with neither plugin", async () => {
    const options = await blockMenuOptions(writing);
    expect(has(options, "Delete")).toBe(true);
    expect(has(options, "Ask AI")).toBe(false);
    expect(has(options, "Comment")).toBe(false);

    const media = await mediaMenuOptions("writing");
    expect(has(media, "Caption")).toBe(true);
    expect(has(media, "Comment")).toBe(false);

    const buttons = await toolbarButtons(writing);
    expect(has(buttons, "Bold")).toBe(true);
    expect(has(buttons, ASK_AI_BUTTON)).toBe(false);
    expect(has(buttons, "Suggestion edits")).toBe(false);

    expect(slashGroups(writing)).toContain("Basic blocks");
    expect(slashGroups(writing)).not.toContain("AI");
  });

  it("follow their own plugin in an editor with only comments", async () => {
    const options = await blockMenuOptions(collaborative);
    expect(has(options, "Comment")).toBe(true);
    expect(has(options, "Ask AI")).toBe(false);
    const buttons = await toolbarButtons(collaborative);
    expect(has(buttons, ASK_AI_BUTTON)).toBe(false);
    expect(has(buttons, "Suggestion edits")).toBe(true);
    expect(slashGroups(collaborative)).not.toContain("AI");
  });

  it("stay in an editor with both plugins", async () => {
    const options = await blockMenuOptions(full);
    expect(has(options, "Ask AI")).toBe(true);
    expect(has(options, "Comment")).toBe(true);
    expect(has(await mediaMenuOptions("full"), "Comment")).toBe(true);
    const buttons = await toolbarButtons(full);
    expect(has(buttons, ASK_AI_BUTTON)).toBe(true);
    expect(has(buttons, "Suggestion edits")).toBe(true);
    expect(slashGroups(full)).toContain("AI");
  });
});
