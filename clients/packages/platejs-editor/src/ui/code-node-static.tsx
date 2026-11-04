import type { SlateLeafProps } from "../exports/platejs-static";
import { SlateLeaf } from "../exports/platejs-static";

export function CodeLeafStatic(props: SlateLeafProps) {
  return (
    <SlateLeaf
      {...props}
      as="code"
      className="whitespace-pre-wrap rounded-md bg-muted px-[0.3em] py-[0.2em] text-sm"
    />
  );
}
