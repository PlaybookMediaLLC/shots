"use client";

import {
  PreviewImage,
  useImagePreview,
  useImagePreviewValue,
  useScaleInput,
} from "@platejs/media/react";
import { ArrowLeftIcon as ArrowLeftIcon } from "@phosphor-icons/react/dist/ssr/ArrowLeft"
import { ArrowRightIcon as ArrowRightIcon } from "@phosphor-icons/react/dist/ssr/ArrowRight"
import { ArrowCircleDownIcon as CircleArrowDown } from "@phosphor-icons/react/dist/ssr/ArrowCircleDown"
import { ArrowsInIcon as Minimize2 } from "@phosphor-icons/react/dist/ssr/ArrowsIn"
import { MinusIcon as Minus } from "@phosphor-icons/react/dist/ssr/Minus"
import { PlusIcon as Plus } from "@phosphor-icons/react/dist/ssr/Plus";
import { useEditorRef } from "platejs/react";
import type { ComponentProps } from "react";
import { downloadFile } from "../lib/download-file";
import { cn } from "../lib/utils";

import { Button } from "./button";

const SCROLL_SPEED = 4;

export function ImagePreview() {
  const editor = useEditorRef();
  const isOpen = useImagePreviewValue("isOpen", editor.id);
  const scale = useImagePreviewValue("scale");
  const isEditingScale = useImagePreviewValue("isEditingScale");
  const currentPreview = useImagePreviewValue("currentPreview");
  const {
    closeProps,
    maskLayerProps,
    nextDisabled,
    nextProps,
    prevDisabled,
    prevProps,
    scaleTextProps,
    zommOutProps,
    zoomInDisabled,
    zoomInProps,
    zoomOutDisabled,
  } = useImagePreview({
    scrollSpeed: SCROLL_SPEED,
  });

  return (
    <div
      className={cn(
        "fade-in fixed top-0 left-0 z-50 h-screen w-screen animate-in cursor-default text-sm duration-200 ease-in-out",
        !isOpen && "hidden"
      )}
    >
      <button
        {...maskLayerProps}
        aria-label="Close image preview"
        className="absolute inset-0 size-full bg-black/80"
        type="button"
      />

      <div className="absolute inset-0 flex items-center justify-center">
        <div className="relative flex max-h-screen w-full items-center">
          <PreviewImage
            className={cn(
              "mx-auto block max-h-[calc(100vh-4rem)] w-auto select-none object-contain transition-transform"
            )}
          />
        </div>
      </div>

      <div className="absolute bottom-[30px] left-1/2 z-40 flex -translate-x-1/2 justify-center gap-2 text-white">
        {!(prevDisabled || nextDisabled) && (
          <div className="flex rounded-md bg-black/70">
            <Button {...prevProps} disabled={prevDisabled}>
              <ArrowLeftIcon className="size-5" />
            </Button>
            <Button {...nextProps} disabled={nextDisabled}>
              <ArrowRightIcon className="size-5" />
            </Button>
          </div>
        )}

        <div className="flex rounded-md bg-black/70">
          <Button
            {...zommOutProps}
            disabled={zoomOutDisabled}
            tooltip="Zoom out"
          >
            <Minus className="size-4" />
          </Button>
          <div className="flex w-[46px] items-center justify-center space-x-1 text-neutral-400">
            {isEditingScale ? (
              <ScaleInput className="h-[19px] w-full rounded-md border border-primary/70 bg-transparent text-sm text-white outline-hidden" />
            ) : (
              <div {...scaleTextProps}>{scale * 100}</div>
            )}
            <div>%</div>
          </div>
          <Button {...zoomInProps} disabled={zoomInDisabled} tooltip="Zoom in">
            <Plus className="size-4" />
          </Button>
          <Button
            onClick={async () => {
              if (!currentPreview?.id) return;

              await downloadFile(currentPreview.url, currentPreview.id);
            }}
            tooltip="Download"
          >
            <CircleArrowDown className="size-4" />
          </Button>
          <Button {...closeProps} tooltip="Close">
            <Minimize2 className="size-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}

function ScaleInput(props: ComponentProps<"input">) {
  const { props: scaleInputProps, ref } = useScaleInput();

  return <input {...scaleInputProps} {...props} ref={ref} />;
}
