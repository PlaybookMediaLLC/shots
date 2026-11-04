import {
  NodeApi,
  SlateElement,
  type SlateElementProps,
  type TCaptionElement,
  type TResizableProps,
  type TVideoElement,
} from "../exports/platejs-static";

import { cn } from "../lib/utils";

export function MediaVideoElementStatic(
  props: SlateElementProps<
    TVideoElement &
      TCaptionElement &
      TResizableProps & { captionUrl?: string }
  >
) {
  const { align = "center", caption, captionUrl, url, width } = props.element;

  return (
    <SlateElement className="py-2.5" {...props}>
      <div style={{ textAlign: align }}>
        <figure
          className="group relative m-0 inline-block cursor-default"
          style={{ width }}
        >
          <video
            className={cn(
              "w-full max-w-full object-cover px-0",
              "rounded-md"
            )}
            controls
            src={url}
          >
            <track
              kind="captions"
              label="Captions"
              src={captionUrl}
              srcLang="en"
            />
          </video>
          {caption && <figcaption>{NodeApi.string(caption[0])}</figcaption>}
        </figure>
      </div>
      {props.children}
    </SlateElement>
  );
}
