import type { SlateElementProps, TMentionElement } from "../exports/platejs-static";
import { IS_APPLE, SlateElement } from "../exports/platejs-static";

import { cn } from "../lib/utils";

export function MentionElementStatic({
  prefix,
  ...props
}: SlateElementProps<TMentionElement> & {
  prefix?: string;
}) {
  const element = props.element;

  return (
    <SlateElement
      {...props}
      attributes={{
        ...props.attributes,
        "data-slate-value": element.value,
      }}
      className={cn(
        "inline-block cursor-pointer rounded-md bg-muted px-1.5 py-0.5 align-baseline font-medium text-sm",
        element.children[0].bold === true && "font-bold",
        element.children[0].italic === true && "italic",
        element.children[0].underline === true && "underline"
      )}
    >
      {IS_APPLE ? (
        // Mac OS IME https://github.com/ianstormtaylor/slate/issues/3490
        <>
          {props.children}
          {prefix}
          {element.value}
        </>
      ) : (
        // Others like Android https://github.com/ianstormtaylor/slate/pull/5360
        <>
          {prefix}
          {element.value}
          {props.children}
        </>
      )}
    </SlateElement>
  );
}
