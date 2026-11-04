import { CaretRightIcon as ChevronRightIcon } from "@phosphor-icons/react/dist/ssr/CaretRight";

import type { SlateElementProps } from "../exports/platejs-static";
import { SlateElement } from "../exports/platejs-static";

export function ToggleElementStatic(props: SlateElementProps) {
  return (
    <SlateElement {...props} className="mb-1 pl-6">
      <div>
        <span
          className="absolute top-0.5 left-0 flex cursor-pointer select-none items-center justify-center rounded-md p-px transition-colors hover:bg-slate-200"
          contentEditable={false}
        >
          <ChevronRightIcon className="rotate-0 transition-transform duration-75" />
        </span>
        {props.children}
      </div>
    </SlateElement>
  );
}
