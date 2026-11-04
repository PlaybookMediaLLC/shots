import assert from "node:assert/strict";
import test from "node:test";
import { isAdFreePath } from "../lib/adsense";

test("editor workspaces are ad free with or without a locale prefix", () => {
  for (const path of ["/", "/de", "/editor", "/code/", "/tweet", "/store-screenshots", "/de/editor", "/ja/store-screenshots"]) {
    assert.equal(isAdFreePath(path), true, path);
  }
});

test("content pages that share a prefix with an editor route still carry ads", () => {
  for (const path of ["/features/code-snippets", "/guides/editor-tips", "/code-snippets", "/xx/editor", "/editor/extra"]) {
    assert.equal(isAdFreePath(path), false, path);
  }
});

test("signed-in app pages are ad free, so links between them stay client-side", () => {
  for (const path of ["/home", "/publish", "/settings/billing", "/upgrade", "/de/upgrade"]) {
    assert.equal(isAdFreePath(path), true, path);
  }
});
