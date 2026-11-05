import type { SlateElementProps } from "../exports/platejs-static";
import { SlateElement } from "../exports/platejs-static";

import { cn } from "../lib/utils";

export function HrElementStatic(props: SlateElementProps) {
  return (
    <SlateElement className="mb-1 py-2" {...props}>
      <div contentEditable={false}>
        <hr
          className={cn(
            "h-0.5 cursor-pointer rounded-md border-none bg-muted bg-clip-content"
          )}
        />
      </div>
      {props.children}
    </SlateElement>
  );
}
