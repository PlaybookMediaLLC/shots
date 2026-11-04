"use client";

import { setMediaNode } from "@platejs/media";
import {
  PlaceholderPlugin,
  PlaceholderProvider,
  usePlaceholderElementState,
  usePlaceholderPopoverState,
} from "@platejs/media/react";
import { WaveformIcon as AudioLinesIcon } from "@phosphor-icons/react/dist/ssr/Waveform"
import { FileArrowUpIcon as FileUpIcon } from "@phosphor-icons/react/dist/ssr/FileArrowUp"
import { FilmStripIcon as FilmIcon } from "@phosphor-icons/react/dist/ssr/FilmStrip"
import { ImageIcon as ImageIcon } from "@phosphor-icons/react/dist/ssr/Image";
import { KEYS, nanoid } from "platejs";
import {
  PlateElement,
  type PlateElementProps,
  useEditorPlugin,
  withHOC,
} from "platejs/react";
import type React from "react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useFilePicker } from "use-file-picker";
import { useUploadFile } from "../hooks/use-upload-file";
import { cn } from "../lib/utils";

import { BlockActionButton } from "./block-context-menu";
import { Button } from "./button";
import { Input } from "./input";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";
import { Spinner } from "./spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./tabs";

const CONTENT: Record<
  string,
  {
    content: ReactNode;
    icon: ReactNode;
  }
> = {
  [KEYS.audio]: {
    content: "Add an audio file",
    icon: <AudioLinesIcon />,
  },
  [KEYS.file]: {
    content: "Add a file",
    icon: <FileUpIcon />,
  },
  [KEYS.img]: {
    content: "Add an image",
    icon: <ImageIcon />,
  },
  [KEYS.video]: {
    content: "Add a video",
    icon: <FilmIcon />,
  },
};

export const PlaceholderElement = withHOC(
  PlaceholderProvider,
  (props: PlateElementProps) => {
    const { mediaType, progresses, progressing, setSize, updatedFiles } =
      usePlaceholderElementState();

    const currentContent = CONTENT[mediaType];

    const isImage = mediaType === KEYS.img;

    const file: File | undefined = updatedFiles?.[0];
    const progress = file ? progresses?.[file.name] : undefined;

    const imageRef = useRef<HTMLImageElement>(null);
    useEffect(() => {
      if (!imageRef.current) return;

      const { height, width } = imageRef.current;

      setSize?.({
        height,
        width,
      });
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [setSize]);

    return (
      <PlateElement className="my-1" {...props}>
        <MediaPlaceholderPopover>
          {!(progressing && isImage) && (
            <button
              className={cn(
                "flex cursor-pointer select-none items-center rounded-md bg-muted p-3 pr-9 transition-colors hover:bg-primary/10"
              )}
              contentEditable={false}
              type="button"
            >
              <div className="relative mr-3 flex text-muted-foreground/80 [&_svg]:size-6">
                {currentContent.icon}
              </div>
              <div className="whitespace-nowrap text-muted-foreground text-sm">
                <div>{progressing ? file?.name : currentContent.content}</div>

                {progressing && !isImage && file && (
                  <div className="mt-1 flex items-center gap-1.5">
                    <div>{formatBytes(file.size)}</div>
                    <div>–</div>
                    <div className="flex items-center">
                      <Spinner className="mr-1 size-3.5" />
                      {progress ?? 0}%
                    </div>
                  </div>
                )}
              </div>
            </button>
          )}
        </MediaPlaceholderPopover>

        {isImage && progressing && file && (
          <ImageProgress file={file} imageRef={imageRef} progress={progress} />
        )}

        <BlockActionButton />

        {props.children}
      </PlateElement>
    );
  }
);

const MEDIA_CONFIG: Record<
  string,
  {
    accept: string[];
    buttonText: string;
    embedText: string;
  }
> = {
  [KEYS.audio]: {
    accept: ["audio/*"],
    buttonText: "Upload Audio",
    embedText: "Embed audio",
  },
  [KEYS.file]: {
    accept: ["*"],
    buttonText: "Choose a file",
    embedText: "Embed file",
  },
  [KEYS.img]: {
    accept: ["image/*"],
    buttonText: "Upload file",
    embedText: "Embed image",
  },
  [KEYS.video]: {
    accept: ["video/*"],
    buttonText: "Upload video",
    embedText: "Embed video",
  },
};

const ignoreUploadError = () => {
  // Upload errors are surfaced through placeholder plugin state and toast handling.
};

function MediaPlaceholderPopover({ children }: { children: React.ReactNode }) {
  const { api, editor, getOption, tf } = useEditorPlugin(PlaceholderPlugin);

  const {
    element,
    mediaType,
    readOnly,
    selected,
    setIsUploading,
    setProgresses,
    setUpdatedFiles,
    size,
  } = usePlaceholderPopoverState();
  const [open, setOpen] = useState(false);

  // Potion-only
  // const documentId = useDocumentId();
  // const createFile = trpc.file.createFile.useMutation();
  const currentMedia = MEDIA_CONFIG[mediaType];

  // const mediaConfig = api.placeholder.getMediaConfig(mediaType as MediaKeys);
  const multiple = getOption("multiple") ?? true;

  const { isUploading, progress, uploadedFile, uploadFile, uploadingFile } =
    useUploadFile({
      onUploadComplete() {
        // Potion-only
        // createFile.mutate({
        //   id: file.key,
        //   appUrl: file.appUrl,
        //   documentId: documentId,
        //   size: file.size,
        //   type: file.type,
        //   url: file.url,
        // });
      },
    });

  const replaceCurrentPlaceholder = useCallback(
    (file: File) => {
      setUpdatedFiles([file]);
      uploadFile(file).catch(ignoreUploadError);
      api.placeholder.addUploadingFile(element.id as string, file);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [element.id, api.placeholder.addUploadingFile, setUpdatedFiles, uploadFile]
  );

  /** Open file picker */
  const { openFilePicker } = useFilePicker({
    accept: currentMedia.accept,
    multiple,
    // @ts-expect-error - use-file-picker type mismatch
    onFilesSelected: ({ plainFiles: updatedFiles }) => {
      const firstFile = updatedFiles[0];
      const restFiles = updatedFiles.slice(1);

      replaceCurrentPlaceholder(firstFile);

      if (restFiles.length > 0) {
        tf.insert.media(restFiles);
      }
    },
  });

  // React dev mode will call useEffect twice
  const isReplaced = useRef(false);
  /** Paste and drop */
  useEffect(() => {
    if (isReplaced.current) return;

    isReplaced.current = true;
    const currentFiles = api.placeholder.getUploadingFile(element.id as string);

    if (!currentFiles) return;

    replaceCurrentPlaceholder(currentFiles);

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api.placeholder.getUploadingFile, element.id, replaceCurrentPlaceholder]);

  useEffect(() => {
    if (!uploadedFile) return;
    if (!mediaType) return;

    const path = editor.api.findPath(element);

    setMediaNode(
      editor,
      {
        id: nanoid(),
        initialHeight: size?.height,
        initialWidth: size?.width,
        isUpload: true,
        name: mediaType === KEYS.file ? uploadedFile.name : "",
        placeholderId: element.id as string,
        type: mediaType,
        url: uploadedFile.url,
        ...(uploadedFile.assetId ? { assetId: uploadedFile.assetId } : {}),
        ...{ mimeType: uploadedFile.type, processingStatus: "ready" },
      },
      { at: path }
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    uploadedFile,
    element.id,
    size,
    editor.api.findPath,
    editor,
    element,
    mediaType,
  ]);

  const [embedValue, setEmbedValue] = useState("");

  const onEmbed = useCallback(
    (value: string) => {
      setMediaNode(editor, {
        type: mediaType,
        url: value,
      });
    },
    [editor, mediaType]
  );

  useEffect(() => {
    setOpen(selected);
  }, [selected]);

  useEffect(() => {
    if (isUploading) {
      setOpen(false);
    }
  }, [isUploading]);

  useEffect(() => {
    setProgresses({ [uploadingFile?.name ?? ""]: progress });
    setIsUploading(isUploading);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [progress, isUploading, uploadingFile, setIsUploading, setProgresses]);

  if (readOnly) return <>{children}</>;

  return (
    <Popover modal={false} onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>

      <PopoverContent
        className="flex flex-col"
        onOpenAutoFocus={(e) => e.preventDefault()}
        variant="media"
      >
        <Tabs className="w-full shrink-0" defaultValue="account">
          <TabsList className="px-2" onMouseDown={(e) => e.preventDefault()}>
            <TabsTrigger value="account">Upload</TabsTrigger>
            <TabsTrigger value="password">Embed link</TabsTrigger>
          </TabsList>
          <TabsContent className="w-[300px] px-3 py-2" value="account">
            <Button className="w-full" onClick={openFilePicker} variant="brand">
              {currentMedia.buttonText}
            </Button>
            <div className="mt-3 text-muted-foreground text-xs">
              The maximum size per file is 5MB
            </div>
          </TabsContent>

          <TabsContent
            className="w-[300px] px-3 pt-2 pb-3 text-center"
            value="password"
          >
            <Input
              onChange={(e) => setEmbedValue(e.target.value)}
              placeholder="Paste the link..."
              value={embedValue}
            />

            <Button
              className="mt-2 w-full max-w-[300px]"
              onClick={() => onEmbed(embedValue)}
              variant="brand"
            >
              {currentMedia.embedText}
            </Button>
          </TabsContent>
        </Tabs>
      </PopoverContent>
    </Popover>
  );
}

function ImageProgress({
  className,
  file,
  imageRef,
  progress = 0,
}: {
  file: File;
  className?: string;
  imageRef?: React.RefObject<HTMLImageElement | null>;
  progress?: number;
}) {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);

  useEffect(() => {
    const url = URL.createObjectURL(file);
    setObjectUrl(url);

    return () => {
      URL.revokeObjectURL(url);
    };
  }, [file]);

  if (!objectUrl) {
    return null;
  }

  return (
    <div className={cn("relative", className)} contentEditable={false}>
      {/* biome-ignore lint/performance/noImgElement: object URL previews use a native img in this framework-agnostic package. */}
      <img
        alt={file.name}
        className="h-auto w-full rounded-md object-cover"
        height={200}
        ref={imageRef}
        src={objectUrl}
        width={200}
      />
      {progress < 100 && (
        <div className="absolute right-1 bottom-1 flex items-center space-x-2 rounded-full bg-black/50 px-1 py-0.5">
          <Spinner />
          <span className="font-medium text-white text-xs">
            {Math.round(progress)}%
          </span>
        </div>
      )}
    </div>
  );
}

function formatBytes(
  bytes: number,
  opts: {
    decimals?: number;
    sizeType?: "accurate" | "normal";
  } = {}
) {
  const { decimals = 0, sizeType = "normal" } = opts;

  const sizes = ["Bytes", "KB", "MB", "GB", "TB"];
  const accurateSizes = ["Bytes", "KiB", "MiB", "GiB", "TiB"];

  if (bytes === 0) return "0 Byte";

  const i = Math.floor(Math.log(bytes) / Math.log(1024));

  return `${(bytes / 1024 ** i).toFixed(decimals)} ${
    sizeType === "accurate"
      ? (accurateSizes[i] ?? "Bytest")
      : (sizes[i] ?? "Bytes")
  }`;
}
