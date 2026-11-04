"use client";

import { AIChatPlugin } from "@platejs/ai/react";
import {
  type CursorData,
  type CursorOverlayState,
  useCursorOverlay,
} from "@platejs/selection/react";
import { RangeApi } from "platejs";
import { usePluginOption } from "platejs/react";

import { cn } from "../lib/utils";

const OVERLAY_ID = "__plate_cursor_overlay__";

// TODO:Move to core
export const getCursorOverlayElement = (): HTMLElement | null =>
  document.querySelector<HTMLElement>(`#${OVERLAY_ID}`);

export function Cursor({
  id,
  caretPosition,
  data,
  selection,
  selectionRects,
}: CursorOverlayState<CursorData>) {
  const streaming = usePluginOption(AIChatPlugin, "streaming");

  if (streaming) return null;

  const { style, selectionStyle = style } = data ?? ({} as CursorData);
  const extendedData = data as
    | (CursorData & { color?: unknown; name?: unknown })
    | undefined;
  const cursorName =
    typeof extendedData?.name === "string" ? extendedData.name : undefined;
  const isCursor = RangeApi.isCollapsed(selection);

  return (
    <>
      {selectionRects.map((position) => (
        <div
          className={cn(
            "pointer-events-none absolute z-10",
            id === "selection" && "bg-primary/25",
            id === "selection" && isCursor && "bg-primary"
          )}
          id={OVERLAY_ID}
          key={`${position.top}-${position.left}-${position.width}-${position.height}`}
          style={{
            ...selectionStyle,
            ...position,
          }}
        />
      ))}
      {caretPosition && (
        <>
          <div
            className={cn(
              "pointer-events-none absolute z-10 w-0.5",
              id === "drag" && "w-px bg-primary"
            )}
            id={OVERLAY_ID}
            style={{ ...caretPosition, ...style }}
          />
          {cursorName && id !== "selection" && (
            <div
              className="pointer-events-none absolute z-20 -translate-y-full whitespace-nowrap rounded-sm px-1.5 py-0.5 font-medium text-label text-white"
              style={{
                backgroundColor:
                  typeof extendedData?.color === "string"
                    ? extendedData.color
                    : "#2563eb",
                left: caretPosition.left,
                top: caretPosition.top,
              }}
            >
              {cursorName}
            </div>
          )}
        </>
      )}
    </>
  );
}

export function CursorOverlay() {
  const { cursors } = useCursorOverlay();

  return (
    <>
      {cursors.map((cursor) => (
        <Cursor key={cursor.id} {...cursor} />
      ))}
    </>
  );
}
