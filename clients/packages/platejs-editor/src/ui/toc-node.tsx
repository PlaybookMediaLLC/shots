import { BlockSelectionPlugin } from "@platejs/selection/react";
import { useTocElement, useTocElementState } from "@platejs/toc/react";
import { cva } from "class-variance-authority";
import { PlateElement, type PlateElementProps } from "platejs/react";

import { Button } from "./button";

const headingItemVariants = cva(
  "block h-auto w-full cursor-pointer truncate rounded-md px-0.5 py-1.5 text-left font-medium text-muted-foreground underline decoration-[0.5px] underline-offset-4 hover:bg-accent hover:text-muted-foreground",
  {
    variants: {
      depth: {
        1: "pl-0.5",
        2: "pl-[26px]",
        3: "pl-[50px]",
      },
    },
  }
);

const getHeadingDepth = (depth: number): 1 | 2 | 3 => {
  if (depth === 1) {
    return 1;
  }
  if (depth === 2) {
    return 2;
  }

  return 3;
};

export function TocElement(props: PlateElementProps) {
  const { editor, element } = props;
  const state = useTocElementState();
  const { props: btnProps } = useTocElement(state);
  const { headingList } = state;

  return (
    <PlateElement {...props} className="my-1">
      <div contentEditable={false}>
        {headingList.length > 0 ? (
          headingList.map((item) => (
            <Button
              aria-current
              className={headingItemVariants({
                depth: getHeadingDepth(item.depth),
              })}
              key={item.id}
              onClick={(e) => btnProps.onClick(e, item, "smooth")}
              variant="ghost"
            >
              {item.title}
            </Button>
          ))
        ) : (
          <button
            className="cursor-text select-none px-1 py-[3px] text-left text-muted-foreground/80 text-sm"
            onClick={() => {
              editor
                .getApi(BlockSelectionPlugin)
                // biome-ignore lint/suspicious/noExplicitAny: complex type
                .blockSelection.set((element as any).id);
            }}
            type="button"
          >
            Add headings to display the table of contents.
          </button>
        )}
      </div>
      {props.children}
    </PlateElement>
  );
}
