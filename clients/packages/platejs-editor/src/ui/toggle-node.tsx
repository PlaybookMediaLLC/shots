import { useToggleButton, useToggleButtonState } from "@platejs/toggle/react";
import { CaretRightIcon as ChevronRightIcon } from "@phosphor-icons/react/dist/ssr/CaretRight";
import {
  PlateElement,
  type PlateElementProps,
  useElement,
} from "platejs/react";

import { cn } from "../lib/utils";

export function ToggleElement(props: PlateElementProps) {
  const element = useElement();
  const state = useToggleButtonState(element.id as string);
  const { buttonProps, open } = useToggleButton(state);

  return (
    <PlateElement {...props} className="mb-1 pl-6">
      <div>
        <span
          className="absolute top-0.5 left-0 flex cursor-pointer select-none items-center justify-center rounded-md p-px transition-colors hover:bg-slate-200"
          contentEditable={false}
          {...buttonProps}
        >
          <ChevronRightIcon
            className={cn(
              "transition-transform duration-75",
              open ? "rotate-90" : "rotate-0"
            )}
          />
        </span>
        {props.children}
      </div>
    </PlateElement>
  );
}
