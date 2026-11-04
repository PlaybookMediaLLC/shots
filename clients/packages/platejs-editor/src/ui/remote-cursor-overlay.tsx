"use client";

// Remote carets and selections of the other people in a collaborative
// session. Added in Screenshot Studio (see UPSTREAM.md), after the Plate
// registry's remote-cursor-overlay.

import { YjsPlugin } from "@platejs/yjs/react";
import {
  type CursorOverlayData,
  useRemoteCursorOverlayPositions,
} from "@slate-yjs/react";
import {
  useEditorContainerRef,
  useEditorRef,
  usePluginOption,
} from "platejs/react";
import { type CSSProperties, type RefObject, useEffect, useState } from "react";

import { cn } from "../lib/utils";

type CursorData = {
  color: string;
  name: string;
  selectionStyle?: CSSProperties;
  style?: CSSProperties;
  userId?: string;
};

/** How long a collaborator's name stays up after their caret moves. */
const NAME_MS = 2000;

function RemoteCursor({
  caretPosition,
  data,
  selectionRects,
}: CursorOverlayData<CursorData>) {
  const selectionStyle = data?.selectionStyle ?? data?.style;
  // The name shows while they type and on hover, then fades to the colored caret.
  const [named, setNamed] = useState(true);
  const top = caretPosition?.top;
  const left = caretPosition?.left;
  useEffect(() => {
    setNamed(true);
    const timer = setTimeout(() => setNamed(false), NAME_MS);
    return () => clearTimeout(timer);
  }, [top, left]);
  return (
    <>
      {selectionRects.map((position, index) => (
        <div
          className="pointer-events-none absolute"
          // biome-ignore lint/suspicious/noArrayIndexKey: rects have no identity
          key={index}
          style={{ ...selectionStyle, ...position }}
        />
      ))}
      {caretPosition ? (
        <div
          className="group/caret pointer-events-none absolute w-0.5"
          data-testid="remote-cursor"
          style={{ ...caretPosition, background: data?.color }}
        >
          {/* A slightly wider hover target than the 2px caret. */}
          <div className="pointer-events-auto absolute inset-y-0 -left-1 w-2.5" />
          <div
            className={cn(
              "absolute top-0 whitespace-nowrap rounded-sm rounded-bl-none px-1.5 py-0.5 font-medium text-label text-white transition-opacity duration-300 group-hover/caret:opacity-100 motion-reduce:transition-none",
              named ? "opacity-100" : "opacity-0"
            )}
            style={{ background: data?.color, transform: "translateY(-100%)" }}
          >
            {data?.name}
          </div>
        </div>
      ) : null}
    </>
  );
}

function RemoteCursors() {
  const editor = useEditorRef();
  const containerRef = useEditorContainerRef();
  const [cursors] = useRemoteCursorOverlayPositions<CursorData>({
    // The container is mounted before the editor renders its overlays.
    containerRef: containerRef as RefObject<HTMLDivElement>,
  });
  // Your own other tabs and devices are you: no caret or name for them here.
  const self = (
    editor.getOptions(YjsPlugin).cursors as { data?: CursorData } | undefined
  )?.data?.userId;
  return (
    <>
      {cursors
        .filter((cursor) => !self || cursor.data?.userId !== self)
        .map((cursor) => (
          <RemoteCursor key={cursor.clientId} {...cursor} />
        ))}
    </>
  );
}

/** Renders once the document has synced; before that there are no peers. */
export function RemoteCursorOverlay() {
  const isSynced = usePluginOption(YjsPlugin, "_isSynced");
  return isSynced ? <RemoteCursors /> : null;
}
