import { FileArrowUpIcon as FileUp } from "@phosphor-icons/react/dist/ssr/FileArrowUp";

import type { SlateElementProps, TFileElement } from "../exports/platejs-static";
import { SlateElement } from "../exports/platejs-static";

export function MediaFileElementStatic(props: SlateElementProps<TFileElement>) {
  const { name, url } = props.element;

  return (
    <SlateElement className="my-px rounded-md" {...props}>
      <a
        className="group relative m-0 flex cursor-pointer items-center rounded px-0.5 py-[3px] hover:bg-muted"
        contentEditable={false}
        download={name}
        href={url}
        rel="noopener noreferrer"
        target="_blank"
      >
        <div className="flex items-center gap-1 p-1">
          <FileUp className="size-5" />
          <div>{name}</div>
        </div>
      </a>

      {props.children}
    </SlateElement>
  );
}
