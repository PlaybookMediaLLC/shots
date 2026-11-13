/**
 * A jsdom window on the globals, for tests that render kit components with
 * react-dom. Import it first: React DOM and Ariakit check for a DOM when they
 * load. Each test file runs in its own process, so it stays in that file.
 */
import { createRequire } from "node:module";

// Required, not imported: this package ships no jsdom type declarations.
const { JSDOM } = createRequire(import.meta.url)("jsdom") as {
  JSDOM: new (
    html: string,
    options: { pretendToBeVisual: boolean; url: string }
  ) => { window: Record<string, unknown> };
};

const { window } = new JSDOM("<!doctype html><html><body></body></html>", {
  pretendToBeVisual: true,
  url: "http://localhost/",
});
const globals = globalThis as unknown as Record<string, unknown>;

for (const key of Object.getOwnPropertyNames(window)) {
  if (!(key in globals)) globals[key] = window[key];
}
globals.IS_REACT_ACT_ENVIRONMENT = true;
