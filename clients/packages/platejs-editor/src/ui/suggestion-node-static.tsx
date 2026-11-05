import { BaseSuggestionPlugin } from "@platejs/suggestion";

import type { SlateLeafProps, TSuggestionText } from "../exports/platejs-static";
import { SlateLeaf } from "../exports/platejs-static";
import { cn } from "../lib/utils";

export function SuggestionLeafStatic(props: SlateLeafProps<TSuggestionText>) {
  const { editor, leaf } = props;

  const dataList = editor
    .getApi(BaseSuggestionPlugin)
    .suggestion.dataList(leaf);
  const hasRemove = dataList.some((data) => data.type === "remove");
  const diffOperation = { type: hasRemove ? "delete" : "insert" } as const;

  const Component = ({ delete: "del", insert: "ins", update: "span" } as const)[
    diffOperation.type
  ];

  return (
    <SlateLeaf
      {...props}
      as={Component}
      className={cn(
        "border-b-2 border-b-primary/[.24] bg-primary/[.08] text-primary/80 no-underline transition-colors duration-200",
        hasRemove &&
          "border-b-gray-300 bg-gray-300/25 text-foreground line-through"
      )}
    >
      {props.children}
    </SlateLeaf>
  );
}
