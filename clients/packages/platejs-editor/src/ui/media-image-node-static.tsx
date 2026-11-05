import type {
  SlateElementProps,
  TCaptionElement,
  TImageElement,
  TResizableProps,
} from "../exports/platejs-static";
import { NodeApi, SlateElement } from "../exports/platejs-static";

export function ImageElementStatic(
  props: SlateElementProps<TImageElement & TCaptionElement & TResizableProps>
) {
  const { align = "center", caption, url, width } = props.element;
  const elementDimensions = props.element as Partial<{
    initialHeight: number;
    initialWidth: number;
  }>;
  const fallbackWidth = Math.max(
    Math.round(
      typeof width === "number"
        ? width
        : (elementDimensions.initialWidth ?? 200)
    ),
    1
  );
  const fallbackHeight = Math.max(
    Math.round(elementDimensions.initialHeight ?? fallbackWidth),
    1
  );

  return (
    <SlateElement className="py-2.5" {...props}>
      <figure className="group relative m-0 inline-block">
        <div
          className="relative min-w-[92px] max-w-full"
          style={{ textAlign: align }}
        >
          <div className="inline-block" style={{ width }}>
            {/* biome-ignore lint/performance/noImgElement: static renderer stays framework-agnostic and cannot depend on Next/Image. */}
            <img
              alt=""
              className="w-full max-w-full cursor-default rounded-md object-cover px-0"
              height={fallbackHeight}
              src={url}
              width={fallbackWidth}
            />
            {caption && (
              <figcaption className="mx-auto mt-2 h-[24px] max-w-full">
                {NodeApi.string(caption[0])}
              </figcaption>
            )}
          </div>
        </div>
      </figure>
      {props.children}
    </SlateElement>
  );
}
