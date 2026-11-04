import { SlateLeaf, type SlateLeafProps } from "../exports/platejs-static";

export function KbdLeafStatic(props: SlateLeafProps) {
  return (
    <SlateLeaf
      {...props}
      as="kbd"
      className="rounded-md border border-border bg-muted px-1.5 py-0.5 font-mono text-sm shadow-sm"
    >
      {props.children}
    </SlateLeaf>
  );
}
