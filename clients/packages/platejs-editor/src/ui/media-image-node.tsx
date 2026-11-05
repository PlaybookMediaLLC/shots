/// <reference path="../types/react-lazy-load-image-component.d.ts" />

"use client";

import { useDraggable } from "@platejs/dnd";
import {
  PlaceholderPlugin,
  useImage,
  useMediaState,
} from "@platejs/media/react";
import { ResizableProvider, useResizableValue } from "@platejs/resizable";
import type { TImageElement } from "platejs";
import {
  PlateElement,
  type PlateElementProps,
  useEditorPlugin,
  withHOC,
} from "platejs/react";
import React, { useEffect, useMemo, useState } from "react";
import { ClosedCaptioningIcon } from "@phosphor-icons/react/dist/ssr/ClosedCaptioning";
import { LazyLoadImage } from "react-lazy-load-image-component";

import { cn } from "../lib/utils";

import { blockSelectionVariants } from "./block-selection";
import { Caption, CaptionTextarea } from "./caption";
import { MediaToolbar } from "./media-toolbar";
import {
  mediaResizeHandleVariants,
  Resizable,
  ResizeHandle,
} from "./resize-handle";

export const ImageElement = withHOC(
  ResizableProvider,
  function ImageElementComponent(props: PlateElementProps<TImageElement>) {
    const { api, editor } = useEditorPlugin(PlaceholderPlugin);

    const print = editor.meta.mode === "print";

    const element = props.element;
    const currentUploadingFile = element.placeholderId
      ? api.placeholder.getUploadingFile(element.placeholderId)
      : undefined;

    const { align = "center", focused, readOnly, selected } = useMediaState();

    const [loading, setLoading] = React.useState(true);

    const width = useResizableValue("width");

    const { props: imageProps } = useImage();

    const height = useMemo<number | null>(() => {
      if (print) return null;
      const initialHeight = element.initialHeight;
      const initialWidth = element.initialWidth;

      if (!(initialHeight && initialWidth)) {
        // Embed image we don't have height and width using 200 by default
        return loading ? 200 : null;
      }
      if (typeof width !== "number" || width === 0) {
        return Number(initialHeight.toFixed(2));
      }

      const aspectRatio = Number((initialWidth / initialHeight).toFixed(2));

      return Number((width / aspectRatio).toFixed(2));
    }, [element.initialHeight, element.initialWidth, loading, print, width]);

    const { isDragging, handleRef } = useDraggable({
      element: props.element,
    });

    const imageWrapperProps = {
      className: cn("block h-full", loading && "absolute"),
      ref: handleRef,
    } satisfies React.HTMLAttributes<HTMLSpanElement> & {
      ref?: React.Ref<unknown>;
    };

    const fallbackWidth = Math.max(
      Math.round(
        typeof width === "number" && width > 0
          ? width
          : (element.initialWidth ?? 200)
      ),
      1
    );
    const fallbackHeight = Math.max(
      Math.round(height ?? element.initialHeight ?? 200),
      1
    );
    const fromPlaceholderId =
      typeof props.element.fromPlaceholderId === "string"
        ? props.element.fromPlaceholderId
        : null;

    return (
      <PlateElement className="my-1" {...props}>
        <figure className="relative m-0" contentEditable={false}>
          <Resizable
            align={align}
            options={{
              align,
              readOnly,
            }}
          >
            <div className="group/media">
              <ResizeHandle
                className={mediaResizeHandleVariants({ direction: "left" })}
                options={{ direction: "left" }}
              />
              <ResizeHandle
                className={mediaResizeHandleVariants({ direction: "right" })}
                options={{ direction: "right" }}
              />

              <div
                className={cn(
                  "relative block w-full max-w-full cursor-pointer object-cover px-0",
                  blockSelectionVariants({ active: focused && selected }),
                  "group-has-data-[resizing=true]/media:before:opacity-0"
                )}
                style={{
                  height: height ? `${height}px` : "auto",
                }}
              >
                {print ? (
                  /* biome-ignore lint/performance/noImgElement: print mode relies on native img sizing. */
                  <img
                    alt=""
                    className={cn("h-full rounded-md")}
                    height={fallbackHeight}
                    style={{ height: "auto", width: "100%" }}
                    width={fallbackWidth}
                    {...imageProps}
                  />
                ) : (
                  <LazyLoadImage
                    className={cn(
                      "h-full rounded-md opacity-100",
                      loading && "opacity-0",
                      isDragging && "opacity-50"
                    )}
                    effect="opacity"
                    height="auto"
                    onLoad={() => {
                      setLoading(false);
                      if (currentUploadingFile && fromPlaceholderId) {
                        api.placeholder.removeUploadingFile(fromPlaceholderId);
                      }
                    }}
                    width="100%"
                    wrapperProps={imageWrapperProps}
                    {...imageProps}
                  />
                )}

                {loading && <ImagePlaceholder file={currentUploadingFile} />}
                {/* The image has a description for screen readers (alt text). */}
                {typeof props.element.alt === "string" && props.element.alt ? (
                  <span
                    className="pointer-events-none absolute bottom-2 left-2 flex items-center gap-1 rounded-sm bg-foreground/75 px-1.5 py-0.5 font-medium text-background text-label"
                    title={props.element.alt}
                  >
                    <ClosedCaptioningIcon aria-hidden className="size-3.5" />
                    ALT
                  </span>
                ) : null}
              </div>

              <MediaToolbar />
            </div>
          </Resizable>

          <Caption align={align} style={{ width }}>
            <CaptionTextarea
              onFocus={(e) => {
                e.preventDefault();
              }}
              placeholder="Write a caption..."
              readOnly={readOnly}
            />
          </Caption>
        </figure>

        {props.children}
      </PlateElement>
    );
  }
);

const ImagePlaceholder = ({ file }: { file?: File }) => {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!file) return;

    const url = URL.createObjectURL(file);
    setObjectUrl(url);

    return () => {
      URL.revokeObjectURL(url);
    };
  }, [file]);

  return (
    <div className="relative h-full overflow-hidden bg-[rgb(247,246,245)] before:absolute before:inset-0 before:z-10 before:animate-shimmer before:bg-linear-to-r before:from-transparent before:via-gray-200/50 before:to-transparent">
      {file && objectUrl && (
        /* biome-ignore lint/performance/noImgElement: object URL previews use a native img for local files. */
        <img
          alt={file.name}
          className="h-auto w-full rounded-md object-cover"
          height={200}
          src={objectUrl}
          width={200}
        />
      )}
    </div>
  );
};
