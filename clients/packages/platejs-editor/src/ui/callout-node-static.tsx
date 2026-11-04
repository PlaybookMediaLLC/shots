import { SlateElement, type SlateElementProps } from "../exports/platejs-static";

export function CalloutElementStatic(props: SlateElementProps) {
  return (
    <SlateElement
      className="my-1 flex rounded-md bg-muted p-4 pl-3"
      style={{
        backgroundColor: props.element.backgroundColor as string | undefined,
      }}
      {...props}
    >
      <div className="flex w-full gap-2 rounded-md">
        <div
          className="size-6 select-none text-lg"
          style={{
            fontFamily:
              '"Apple Color Emoji", "Segoe UI Emoji", NotoColorEmoji, "Noto Color Emoji", "Segoe UI Symbol", "Android Emoji", EmojiSymbols',
          }}
        >
          <span data-plate-prevent-deserialization>
            {(props.element.icon as string | undefined) ?? "💡"}
          </span>
        </div>
        <div className="w-full">{props.children}</div>
      </div>
    </SlateElement>
  );
}
