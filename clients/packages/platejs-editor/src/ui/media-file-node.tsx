"use client";

import { useMediaState } from "@platejs/media/react";
import { ResizableProvider } from "@platejs/resizable";
import { FileArrowUpIcon as FileUpIcon } from "@phosphor-icons/react/dist/ssr/FileArrowUp";
import {
  PlateElement,
  type PlateElementProps,
  useReadOnly,
  withHOC,
} from "platejs/react";

import { openSafeUrl } from "../lib/safe-url";
import { BlockActionButton } from "./block-context-menu";
import { Caption, CaptionTextarea } from "./caption";

export const MediaFileElement = withHOC(
  ResizableProvider,
  function MediaFileElementContent(props: PlateElementProps) {
    const readOnly = useReadOnly();
    const { name, unsafeUrl } = useMediaState();

    const onDownload = () => {
      openSafeUrl(unsafeUrl, "_blank");
    };

    return (
      <PlateElement className="my-px rounded-md" {...props}>
        <div
          className="group relative m-0 rounded px-0.5 py-[3px] transition-colors hover:bg-muted"
          contentEditable={false}
        >
          <button
            className="flex w-full cursor-pointer items-center gap-1 p-1 text-left"
            onClick={onDownload}
            type="button"
          >
            <FileUpIcon className="size-5" />
            <div>{name}</div>
          </button>

          <Caption align="left">
            <CaptionTextarea
              className="text-left"
              placeholder="Write a caption..."
              readOnly={readOnly}
            />
          </Caption>

          <BlockActionButton className="top-1/2 -translate-y-1/2" />
        </div>

        {props.children}
      </PlateElement>
    );
  }
);
