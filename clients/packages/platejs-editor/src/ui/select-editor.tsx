"use client";

import { z } from "zod";
import { isEqualTags } from "@platejs/tag";
import {
  MultiSelectPlugin,
  TagPlugin,
  useSelectableItems,
  useSelectEditorCombobox,
} from "@platejs/tag/react";
import {
  Command as CommandPrimitive,
  useCommandActions,
} from "@udecode/cmdk";
import { Fzf } from "fzf";
import { PlusIcon as PlusIcon } from "@phosphor-icons/react/dist/ssr/Plus";
import { isHotkey, KEYS } from "platejs";
import {
  Plate,
  useEditorContainerRef,
  useEditorRef,
  usePlateEditor,
} from "platejs/react";
import type { ComponentProps, ReactNode, Ref } from "react";
import { createContext, useContext, useEffect, useState } from "react";

import { cn } from "../lib/utils";
import { Editor, EditorContainer } from "./editor";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "./popover";
import { TagElement } from "./tag-node";

export interface SelectItem extends Record<string, unknown> {
  value: string;
  isNew?: boolean;
  url?: string;
}

const tagDataSchema = z.object({
  isNew: z.boolean().optional(),
  url: z.string().optional(),
  value: z.string(),
});

/**
 * Whitelists a {@link SelectItem} down to the fields that are safe to place on
 * a Slate tag node. Because items can originate from external/untrusted sources
 * and `SelectItem` allows arbitrary keys, spreading them directly could
 * override reserved node fields like `type` or `children` and produce an
 * invalid node tree. Parsing through the schema strips any unknown keys.
 *
 * @param item - The select item, potentially carrying extra keys.
 * @returns The item narrowed to `{ value, isNew?, url? }`.
 */
function toTagData(item: SelectItem) {
  return tagDataSchema.parse(item);
}

interface SelectEditorContextValue {
  items: SelectItem[];
  open: boolean;
  setOpen: (open: boolean) => void;
  value?: SelectItem[];
  onValueChange?: (items: SelectItem[]) => void;
}

const SelectEditorContext = createContext<SelectEditorContextValue | null>(
  null
);

const useSelectEditorContext = () => {
  const context = useContext(SelectEditorContext);

  if (!context) {
    throw new Error("SelectEditor components must be used inside SelectEditor");
  }

  return context;
};

export function SelectEditor({
  children,
  defaultValue,
  items = [],
  value,
  onValueChange,
}: {
  children: ReactNode;
  defaultValue?: SelectItem[];
  items?: SelectItem[];
  value?: SelectItem[];
  onValueChange?: (items: SelectItem[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [internalValue] = useState(defaultValue);

  return (
    <SelectEditorContext.Provider
      value={{
        items,
        open,
        setOpen,
        value: value ?? internalValue,
        onValueChange,
      }}
    >
      <Command className="overflow-visible bg-transparent" loop shouldFilter={false}>
        {children}
      </Command>
    </SelectEditorContext.Provider>
  );
}

export function SelectEditorContent({ children }: { children: ReactNode }) {
  const { value } = useSelectEditorContext();
  const { setSearch } = useCommandActions();
  const editor = usePlateEditor(
    {
      plugins: [MultiSelectPlugin.withComponent(TagElement)],
      value: createEditorValue(value),
    },
    []
  );

  useEffect(() => {
    if (!isEqualTags(editor, value)) {
      editor.tf.replaceNodes(createEditorValue(value), {
        at: [],
        children: true,
      });
    }
  }, [editor, value]);

  return (
    <Plate
      editor={editor}
      onValueChange={({ editor: currentEditor }) => {
        setSearch(currentEditor.api.string([]));
      }}
    >
      <EditorContainer variant="select">{children}</EditorContainer>
    </Plate>
  );
}

export function SelectEditorInput({
  ref,
  ...props
}: ComponentProps<typeof Editor> & { ref?: Ref<HTMLDivElement> }) {
  const editor = useEditorRef();
  const { setOpen } = useSelectEditorContext();
  const { selectCurrentItem, selectFirstItem } = useCommandActions();

  return (
    <Editor
      autoFocusOnEditable
      onBlur={() => setOpen(false)}
      onFocusCapture={() => {
        setOpen(true);
        selectFirstItem();
      }}
      onKeyDown={(event) => {
        if (isHotkey("enter", event)) {
          event.preventDefault();
          selectCurrentItem();
          editor.tf.removeNodes({ at: [], empty: false, text: true });
        }
        if (isHotkey("escape", event) || isHotkey("mod+enter", event)) {
          event.preventDefault();
          event.currentTarget.blur();
        }
      }}
      ref={ref}
      variant="select"
      {...props}
    />
  );
}

export function SelectEditorCombobox() {
  const editor = useEditorRef();
  const containerRef = useEditorContainerRef();
  const { items, open, onValueChange } = useSelectEditorContext();
  const selectableItems = useSelectableItems({ filter: fuzzyFilter, items });
  const { selectFirstItem } = useCommandActions();
  const virtualRef = containerRef as ComponentProps<
    typeof PopoverAnchor
  >["virtualRef"];

  useSelectEditorCombobox({ open, selectFirstItem, onValueChange });

  if (!(open && selectableItems.length > 0)) {
    return null;
  }

  return (
    <Popover open={open}>
      <PopoverAnchor virtualRef={virtualRef} />
      <PopoverContent
        align="start"
        alignOffset={-4}
        className="p-0 data-[state=open]:animate-none"
        onCloseAutoFocus={(event) => event.preventDefault()}
        onOpenAutoFocus={(event) => event.preventDefault()}
        sideOffset={8}
        style={{ width: (containerRef.current?.offsetWidth ?? 0) + 8 }}
      >
        <CommandList>
          <CommandGroup>
            {selectableItems.map((item) => (
              <CommandItem
                className="cursor-pointer gap-2"
                key={item.value}
                onMouseDown={(event) => event.preventDefault()}
                onSelect={() => {
                  editor.getTransforms(TagPlugin).insert.tag(toTagData(item));
                }}
              >
                {item.isNew ? (
                  <span className="flex items-center gap-1">
                    <PlusIcon className="size-4" />
                    Create new label: “{item.value}”
                  </span>
                ) : (
                  item.value
                )}
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
      </PopoverContent>
    </Popover>
  );
}

const createEditorValue = (value?: SelectItem[]) => [
  {
    children: [
      { text: "" },
      ...(value?.flatMap((item) => [
        {
          children: [{ text: "" }],
          type: KEYS.tag,
          ...toTagData(item),
        },
        { text: "" },
      ]) ?? []),
    ],
    type: KEYS.p,
  },
];

const fuzzyFilter = (value: string, search: string) => {
  if (!search) {
    return true;
  }

  return (
    new Fzf([value], {
      casing: "case-insensitive",
      selector: (candidate: string) => candidate,
    }).find(search).length > 0
  );
};

function Command({
  className,
  ...props
}: ComponentProps<typeof CommandPrimitive>) {
  return (
    <CommandPrimitive
      className={cn(
        "flex h-full w-full flex-col overflow-hidden rounded-md bg-popover text-popover-foreground",
        className
      )}
      {...props}
    />
  );
}

function CommandList({
  className,
  ...props
}: ComponentProps<typeof CommandPrimitive.List>) {
  return (
    <CommandPrimitive.List
      className={cn(
        "max-h-[300px] scroll-py-1 overflow-y-auto overflow-x-hidden",
        className
      )}
      {...props}
    />
  );
}

function CommandGroup({
  className,
  ...props
}: ComponentProps<typeof CommandPrimitive.Group>) {
  return (
    <CommandPrimitive.Group
      className={cn("overflow-hidden p-1 text-foreground", className)}
      {...props}
    />
  );
}

function CommandItem({
  className,
  ...props
}: ComponentProps<typeof CommandPrimitive.Item>) {
  return (
    <CommandPrimitive.Item
      className={cn(
        "relative flex cursor-default select-none items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-hidden data-[disabled=true]:pointer-events-none data-[selected=true]:bg-accent data-[disabled=true]:opacity-50",
        className
      )}
      {...props}
    />
  );
}
