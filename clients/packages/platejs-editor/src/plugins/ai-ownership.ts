import {
  getSuggestionKey,
  getTransientSuggestionKey,
  rejectSuggestion,
} from "@platejs/suggestion";
import { SuggestionPlugin } from "@platejs/suggestion/react";
import { type Descendant, KEYS } from "platejs";
import type { PlateEditor } from "platejs/react";

import { nid } from "../lib/nid";

/**
 * Whose AI text is whose. A shared document also holds the other writers'
 * unaccepted AI text, so each editor stamps what its own requests write and
 * discards only that.
 */
const writers = new WeakMap<object, { id: string; suggestions: Set<string> }>();

export const aiWriter = (editor: object) => {
  let writer = writers.get(editor);
  if (!writer) {
    writer = { id: nid(), suggestions: new Set() };
    writers.set(editor, writer);
  }
  return writer;
};

const pendingSuggestions = (editor: PlateEditor) =>
  editor.plugins[KEYS.suggestion]
    ? editor
        .getApi(SuggestionPlugin)
        .suggestion.nodes({ transient: true })
        .flatMap(([node]) => {
          const data = editor
            .getApi(SuggestionPlugin)
            .suggestion.suggestionData(node);
          return data ? [data] : [];
        })
    : [];

/** The writer kept the text: it is theirs now, and no later discard may take it. */
export const keepOwnAI = (editor: PlateEditor) => {
  const writer = aiWriter(editor);
  writer.id = nid();
  writer.suggestions.clear();
};

/** Runs `apply` and records the pending suggestions it added as this editor's. */
export const recordAISuggestions = (editor: PlateEditor, apply: () => void) => {
  const before = new Set(pendingSuggestions(editor).map((data) => data.id));
  apply();
  for (const data of pendingSuggestions(editor)) {
    if (!before.has(data.id)) aiWriter(editor).suggestions.add(data.id);
  }
};

/** Takes back this editor's unaccepted AI blocks, text and suggestions. */
export const discardOwnAI = (editor: PlateEditor) => {
  const writer = aiWriter(editor);
  // Only the stamp decides: another editor whose AI menu is closed strips the
  // `ai` mark from text it receives (Plate's normalizer), so the mark can be gone.
  const mine = (node: Descendant) => node.aiBy === writer.id;
  editor.tf.withoutNormalizing(() => {
    const written = (node: Descendant): boolean =>
      "text" in node
        ? mine(node) || node.text === ""
        : (node.children as Descendant[]).every(written);
    const marked = (node: Descendant): boolean =>
      "text" in node
        ? mine(node)
        : (node.children as Descendant[]).some(marked);
    for (let index = editor.children.length - 1; index >= 0; index -= 1) {
      const block = editor.children[index]!;
      if (marked(block) && written(block)) {
        editor.tf.removeNodes({ at: [index] });
      }
    }
    editor.tf.removeNodes({
      at: [],
      match: (node) => mine(node as Descendant),
    });
    const own = pendingSuggestions(editor).filter((data) =>
      writer.suggestions.has(data.id)
    );
    for (const data of own) {
      rejectSuggestion(editor, {
        createdAt: new Date(data.createdAt),
        keyId: getSuggestionKey(data.id),
        suggestionId: data.id,
        type: data.type,
        userId: data.userId,
      });
    }
    if (own.length > 0) {
      editor.tf.unsetNodes([getTransientSuggestionKey()], {
        at: [],
        mode: "all",
        match: (node) =>
          Boolean(node[getTransientSuggestionKey()]) &&
          !editor.getApi(SuggestionPlugin).suggestion.suggestionData(node as never),
      });
    }
    writer.suggestions.clear();
  });
};
