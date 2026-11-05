import { SlateLeaf, type SlateLeafProps } from "../exports/platejs-static";

export function HighlightLeafStatic(props: SlateLeafProps) {
  return (
    <SlateLeaf {...props} as="mark" className="bg-primary/30 text-inherit">
      {props.children}
    </SlateLeaf>
  );
}
