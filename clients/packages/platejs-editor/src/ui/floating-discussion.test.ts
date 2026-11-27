import assert from "node:assert/strict";
import test from "node:test";
import { resolveOverlappingTop } from "./floating-discussion";

function makePanel(height: number, reads: { count: number }): HTMLDivElement {
  return {
    get clientHeight() {
      reads.count += 1;
      return height;
    },
  } as unknown as HTMLDivElement;
}

test("resolveOverlappingTop stacks unsorted overlapping panels in O(N) with one layout read each", () => {
  const readsA = { count: 0 };
  const readsB = { count: 0 };
  const readsC = { count: 0 };
  const readsD = { count: 0 };

  const result = resolveOverlappingTop(
    { c: 40, a: 10, d: 300, b: 30, missing: 20 },
    {
      a: makePanel(50, readsA),
      b: makePanel(40, readsB),
      c: makePanel(60, readsC),
      d: makePanel(30, readsD),
      missing: null,
    }
  );

  // a starts at 10 (height 50 + gap 10 -> next >= 70)
  // b wanted 30 -> pushed to 70 (height 40 + gap 10 -> next >= 120)
  // c wanted 40 -> pushed to 120 (height 60 + gap 10 -> next >= 190)
  // d wanted 300 -> stays 300
  // missing has no DOM ref -> keeps its original top
  assert.deepEqual(result, {
    a: 10,
    b: 70,
    c: 120,
    d: 300,
    missing: 20,
  });

  // Each mounted panel's clientHeight is read at most once.
  assert.equal(readsA.count, 1);
  assert.equal(readsB.count, 1);
  assert.equal(readsC.count, 1);
  assert.equal(readsD.count, 1);
});
