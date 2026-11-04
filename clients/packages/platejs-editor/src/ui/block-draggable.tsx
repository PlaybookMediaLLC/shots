"use client";

import { DndPlugin, useDraggable, useDropLine } from "@platejs/dnd";
import { expandListItemsWithChildren } from "@platejs/list";
import { BlockSelectionPlugin } from "@platejs/selection/react";
import { DotsSixVerticalIcon as GripVertical } from "@phosphor-icons/react/dist/ssr/DotsSixVertical"
import { PlusIcon as PlusIcon } from "@phosphor-icons/react/dist/ssr/Plus";
import {
  getPluginByType,
  isType,
  KEYS,
  type Path,
  PathApi,
  type TElement,
} from "platejs";
import {
  MemoizedChildren,
  type PlateEditor,
  type PlateElementProps,
  type RenderNodeWrapper,
  useEditorRef,
  useElement,
  usePluginOption,
  useSelected,
} from "platejs/react";
import {
  type ComponentProps,
  memo,
  type MouseEvent as ReactMouseEvent,
  type Ref,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import { cn } from "../lib/utils";

import { BlockMenu } from "./block-menu";
import { Button } from "./button";

const UNDRAGGABLE_KEYS = [KEYS.column, KEYS.tr, KEYS.td];
type SelectedBlocks = [TElement, Path][];

const assignRef = <T,>(ref: Ref<T> | undefined, value: T | null) => {
  if (typeof ref === "function") {
    ref(value);
    return;
  }

  if (ref) {
    (ref as { current: T | null }).current = value;
  }
};

const getElementId = (element: TElement): string | undefined =>
  typeof element.id === "string" ? element.id : undefined;

const getBlockIds = (blocks: TElement[]): string[] => {
  const ids: string[] = [];

  for (const block of blocks) {
    const id = getElementId(block);

    if (id) {
      ids.push(id);
    }
  }

  return ids;
};

const ensureElementSelection = (
  editor: PlateEditor,
  element: TElement,
  selectedBlocks: SelectedBlocks
): SelectedBlocks => {
  if (selectedBlocks.some(([node]) => node.id === element.id)) {
    return selectedBlocks;
  }

  const elementPath = editor.api.findPath(element);
  return elementPath ? [[element, elementPath]] : selectedBlocks;
};

const hasAncestorBlock = (
  editor: PlateEditor,
  path: Path,
  key: string
): boolean =>
  editor.api.some({
    at: path,
    match: {
      type: editor.getType(key),
    },
  });

const isBlockDraggable = (
  editor: PlateEditor,
  element: TElement,
  path: Path
): boolean => {
  if (editor.dom.readOnly || isType(editor, element, UNDRAGGABLE_KEYS)) {
    return false;
  }

  if (path.length === 1) {
    return true;
  }

  if (path.length === 3) {
    return hasAncestorBlock(editor, path, KEYS.column);
  }

  if (path.length === 4) {
    return hasAncestorBlock(editor, path, KEYS.table);
  }

  return false;
};

export const BlockDraggable: RenderNodeWrapper = (props) => {
  const { editor, element, path } = props;
  const enabled = isBlockDraggable(editor, element, path);

  if (!enabled) return;

  return (renderProps) => <Draggable {...renderProps} />;
};

function Draggable(props: PlateElementProps) {
  const { children, editor, element, path } = props;
  const blockSelectionApi = editor.getApi(BlockSelectionPlugin).blockSelection;
  const elementId = getElementId(element);

  const { isAboutToDrag, isDragging, nodeRef, previewRef, handleRef } =
    useDraggable({
      element,
      onDropHandler: (_, { dragItem }) => {
        const id = (dragItem as { id: string[] | string }).id;

        if (blockSelectionApi) {
          blockSelectionApi.add(id);
        }

        resetPreview();
      },
    });

  const isInColumn = path.length === 3;
  const isInTable = path.length === 4;
  const [previewTop, setPreviewTop] = useState(0);
  const [dragButtonTop, setDragButtonTop] = useState(0);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  const resetPreview = useCallback(() => {
    const previewNode = previewRef.current;

    if (!previewNode) {
      return;
    }

    previewNode.replaceChildren();
    previewNode.classList.add("hidden");
  }, [previewRef]);

  // clear up virtual multiple preview when drag end
  useEffect(() => {
    if (!isDragging) {
      resetPreview();
    }
  }, [isDragging, resetPreview]);

  useEffect(() => {
    if (isAboutToDrag) {
      previewRef.current?.classList.remove("opacity-0");
    }
  }, [isAboutToDrag, previewRef]);

  useEffect(() => {
    if (!isDragging) {
      setDragButtonTop(calcDragButtonTop(editor, element));
    }
  }, [editor, element, isDragging]);

  const setWrapperNodeRef = useCallback(
    (node: HTMLDivElement | null) => {
      wrapperRef.current = node;
      assignRef(nodeRef, node);
    },
    [nodeRef]
  );

  useEffect(() => {
    const wrapperNode = wrapperRef.current;

    if (!wrapperNode) {
      return;
    }

    const handleContextMenu = (event: MouseEvent) => {
      blockSelectionApi.addOnContextMenu({
        element,
        event: event as unknown as ReactMouseEvent<HTMLDivElement>,
      });
    };

    wrapperNode.addEventListener("contextmenu", handleContextMenu);
    return () => {
      wrapperNode.removeEventListener("contextmenu", handleContextMenu);
    };
  }, [blockSelectionApi, element]);

  const handlePreviewMouseDown = useCallback(
    (event: ReactMouseEvent<HTMLButtonElement>) => {
      resetPreview();

      if (event.button !== 0 || event.shiftKey) {
        return;
      }

      const blockSelection = blockSelectionApi.getNodes({ sort: true });
      const selectionNodes = ensureElementSelection(
        editor,
        element,
        (blockSelection.length > 0
          ? blockSelection
          : editor.api.blocks({ mode: "highest" })) as SelectedBlocks
      );
      const blocks = expandListItemsWithChildren(editor, selectionNodes).map(
        ([node]) => node
      );

      if (blockSelection.length === 0) {
        editor.tf.blur();
        editor.tf.collapse();
      }

      const previewElements = createDragPreviewElements(editor, blocks);
      const previewNode = previewRef.current;

      previewNode?.append(...previewElements);
      previewNode?.classList.remove("hidden");
      previewNode?.classList.add("opacity-0");
      editor.setOption(DndPlugin, "multiplePreviewRef", previewRef);

      const blockIds = getBlockIds(blocks);

      if (blockIds.length > 0) {
        blockSelectionApi.add(blockIds);
      }
    },
    [blockSelectionApi, editor, element, previewRef, resetPreview]
  );

  const handlePreviewMouseEnter = useCallback(() => {
    if (isDragging) {
      return;
    }

    const blockSelection = blockSelectionApi.getNodes({ sort: true });
    const selectedBlocks = ensureElementSelection(
      editor,
      element,
      (blockSelection.length > 0
        ? blockSelection
        : editor.api.blocks({ mode: "highest" })) as SelectedBlocks
    );
    const processedBlocks = expandListItemsWithChildren(editor, selectedBlocks);
    const selectedBlockElements = processedBlocks.map(([node]) => node);
    const selectedBlockIds = getBlockIds(selectedBlockElements);

    if (
      elementId &&
      selectedBlockIds.length > 1 &&
      selectedBlockIds.includes(elementId)
    ) {
      setPreviewTop(
        calculatePreviewTop(editor, {
          blocks: selectedBlockElements,
          element,
        })
      );
      return;
    }

    setPreviewTop(0);
  }, [blockSelectionApi, editor, element, elementId, isDragging]);

  return (
    <div
      className={cn(
        "relative",
        isDragging && "opacity-50",
        getPluginByType(editor, element.type)?.node.isContainer
          ? "group/container"
          : "group"
      )}
    >
      {!isInTable && (
        <Gutter>
          <div
            className={cn(
              "slate-blockToolbarWrapper",
              "flex h-[1.5em]",
              isInColumn && "h-4",
              isInTable && "mt-1 size-4"
            )}
          >
            <div
              className={cn(
                "slate-blockToolbar relative w-13",
                "pointer-events-auto mr-1 flex items-center",
                isInColumn && "mr-1.5"
              )}
            >
              <BlockMenu animateZoom id={elementId} placement="left">
                <Button
                  className="absolute right-0 h-6 w-6 p-0"
                  data-plate-prevent-deselect
                  label="Drag block"
                  onMouseDown={handlePreviewMouseDown}
                  onMouseEnter={handlePreviewMouseEnter}
                  onMouseUp={resetPreview}
                  ref={handleRef}
                  style={{ top: `${dragButtonTop + 3}px` }}
                  tooltip={
                    <div className="text-center">
                      Drag <span className="text-foreground">to move</span>
                      <br />
                      Click{" "}
                      <span className="text-foreground">to open menu</span>
                    </div>
                  }
                  tooltipContentProps={{
                    side: "bottom",
                  }}
                  variant="ghost"
                >
                  <GripVertical className="text-muted-foreground" />
                </Button>
              </BlockMenu>

              {!(isInColumn || isInTable) && (
                <div
                  className="absolute left-0 h-6"
                  style={{ top: `${dragButtonTop + 3}px` }}
                >
                  <DraggableInsertHandle />
                </div>
              )}
            </div>
          </div>
        </Gutter>
      )}

      <div
        className={cn("absolute -left-0 hidden w-full")}
        contentEditable={false}
        ref={previewRef}
        style={{ top: `${-previewTop}px` }}
      />

      <div
        className="slate-blockWrapper my-px flow-root"
        ref={setWrapperNodeRef}
      >
        <MemoizedChildren>{children}</MemoizedChildren>
        <DropLine />
      </div>
    </div>
  );
}

function Gutter({ children, className, ...props }: ComponentProps<"div">) {
  const editor = useEditorRef();
  const element = useElement();
  const isSelectionAreaVisible = usePluginOption(
    BlockSelectionPlugin,
    "isSelectionAreaVisible"
  );
  const selected = useSelected();

  return (
    <div
      {...props}
      className={cn(
        "slate-gutterLeft",
        "absolute top-0 z-50 flex h-full -translate-x-full cursor-text hover:opacity-100 sm:opacity-0",
        getPluginByType(editor, element.type)?.node.isContainer
          ? "group-hover/container:opacity-100"
          : "group-hover:opacity-100",
        isSelectionAreaVisible && "hidden",
        !selected && "opacity-0",
        className
      )}
      contentEditable={false}
    >
      {children}
    </div>
  );
}

const DropLine = memo(function DropLineComponent({
  className,
  ...props
}: ComponentProps<"div">) {
  const { dropLine } = useDropLine();

  if (!dropLine) return null;

  return (
    <div
      {...props}
      className={cn(
        "slate-dropLine",
        "absolute inset-x-0 h-0.5 opacity-100 transition-opacity",
        "bg-primary/50",
        dropLine === "top" && "-top-px",
        dropLine === "bottom" && "-bottom-px",
        className
      )}
    />
  );
});

const DraggableInsertHandle = () => {
  const editor = useEditorRef();
  const element = useElement();

  return (
    <Button
      aria-label="Insert block below (Option-click to insert above)"
      className="size-6 shrink-0 p-1"
      onClick={(event) => {
        event.stopPropagation();
        event.preventDefault();

        const at = editor.api.findPath(element);
        triggerComboboxNextBlock(editor, "/", at, event.altKey);
      }}
      onMouseDown={() => {
        editor.tf.focus();
        editor.getApi(BlockSelectionPlugin).blockSelection.clear();
      }}
      tabIndex={-1}
      tooltip={
        <div className="text-center">
          Click <span className="text-foreground">to add below</span>
          <br />
          Option-click <span className="text-foreground">to add above</span>
        </div>
      }
      tooltipContentProps={{
        side: "bottom",
      }}
      variant="ghost"
    >
      <PlusIcon className="size-6 text-muted-foreground/70" />
    </Button>
  );
};

const triggerComboboxNextBlock = (
  editor: PlateEditor,
  triggerText: string,
  at?: Path,
  insertAbove = false
) => {
  let _at: Path | undefined;

  if (at) {
    const slicedPath = at.slice(0, 1);
    _at = insertAbove ? slicedPath : PathApi.next(slicedPath);
  }

  editor.tf.insertNodes(editor.api.create.block(), {
    at: _at,
    select: true,
  });
  editor.tf.insertText(triggerText);
};

const createDragPreviewElements = (
  editor: PlateEditor,
  blocks: TElement[]
): HTMLElement[] => {
  const elements: HTMLElement[] = [];
  const ids: string[] = [];

  /**
   * Remove data attributes from the element to avoid recognized as slate
   * elements incorrectly.
   */
  const removeDataAttributes = (element: HTMLElement) => {
    Array.from(element.attributes).forEach((attr) => {
      if (
        attr.name.startsWith("data-slate") ||
        attr.name.startsWith("data-block-id")
      ) {
        element.removeAttribute(attr.name);
      }
    });

    Array.from(element.children).forEach((child) => {
      removeDataAttributes(child as HTMLElement);
    });
  };

  const resolveElement = (node: TElement, index: number) => {
    const domNode = editor.api.toDOMNode(node);

    if (!domNode) {
      return;
    }

    const newDomNode = domNode.cloneNode(true) as HTMLElement;

    // Apply visual compensation for horizontal scroll
    const applyScrollCompensation = (
      original: Element,
      cloned: HTMLElement
    ) => {
      const scrollLeft = original.scrollLeft;

      if (scrollLeft > 0) {
        // Create a wrapper to handle the scroll offset
        const scrollWrapper = document.createElement("div");
        scrollWrapper.style.overflow = "hidden";
        scrollWrapper.style.width = `${original.clientWidth}px`;

        // Create inner container with the full content
        const innerContainer = document.createElement("div");
        innerContainer.style.transform = `translateX(-${scrollLeft}px)`;
        innerContainer.style.width = `${original.scrollWidth}px`;

        // Move all children to the inner container
        while (cloned.firstChild) {
          innerContainer.append(cloned.firstChild);
        }

        // Apply the original element's styles to maintain appearance
        const originalStyles = window.getComputedStyle(original);
        cloned.style.padding = "0";
        innerContainer.style.padding = originalStyles.padding;

        scrollWrapper.append(innerContainer);
        cloned.append(scrollWrapper);
      }
    };

    applyScrollCompensation(domNode, newDomNode);

    const nodeId = getElementId(node);

    if (nodeId) {
      ids.push(nodeId);
    }

    const wrapper = document.createElement("div");
    wrapper.append(newDomNode);
    wrapper.style.display = "flow-root";

    const lastDomNode = blocks[index - 1];

    if (lastDomNode) {
      const lastDomNodeRect = editor.api
        .toDOMNode(lastDomNode)
        ?.parentElement?.getBoundingClientRect();

      const domNodeRect = domNode.parentElement?.getBoundingClientRect();

      const distance = (domNodeRect?.top ?? 0) - (lastDomNodeRect?.bottom ?? 0);

      // Check if the two elements are adjacent (touching each other)
      if (distance > 15) {
        wrapper.style.marginTop = `${distance}px`;
      } else {
        // DIFF with plate
        wrapper.style.marginTop = "1px";
      }
    }

    removeDataAttributes(newDomNode);
    elements.push(wrapper);
  };

  for (const [index, block] of blocks.entries()) {
    resolveElement(block, index);
  }

  editor.setOption(DndPlugin, "draggingId", ids);

  return elements;
};

const calculatePreviewTop = (
  editor: PlateEditor,
  {
    blocks,
    element,
  }: {
    blocks: TElement[];
    element: TElement;
  }
): number => {
  const firstSelectedChild = blocks[0];
  const child = editor.api.toDOMNode(element);
  const editable = editor.api.toDOMNode(editor);
  const firstDomNode = firstSelectedChild
    ? editor.api.toDOMNode(firstSelectedChild)
    : null;

  if (!(child && editable && firstDomNode)) {
    return 0;
  }

  // Get editor's top padding
  const editorPaddingTop = Number(
    window.getComputedStyle(editable).paddingTop.replace("px", "")
  );

  // Calculate distance from first selected node to editor top
  const firstNodeToEditorDistance =
    firstDomNode.getBoundingClientRect().top -
    editable.getBoundingClientRect().top -
    editorPaddingTop;

  // Get margin top of first selected node
  const firstMarginTopString = window.getComputedStyle(firstDomNode).marginTop;
  const marginTop = Number(firstMarginTopString.replace("px", ""));

  // Calculate distance from current node to editor top
  const currentToEditorDistance =
    child.getBoundingClientRect().top -
    editable.getBoundingClientRect().top -
    editorPaddingTop;

  const currentMarginTopString = window.getComputedStyle(child).marginTop;
  const currentMarginTop = Number(currentMarginTopString.replace("px", ""));

  const previewElementsTopDistance =
    currentToEditorDistance -
    firstNodeToEditorDistance +
    marginTop -
    currentMarginTop;

  return previewElementsTopDistance;
};

const calcDragButtonTop = (editor: PlateEditor, element: TElement): number => {
  const child = editor.api.toDOMNode(element);

  if (!child) {
    return 0;
  }

  const currentMarginTopString = window.getComputedStyle(child).marginTop;
  const currentMarginTop = Number(currentMarginTopString.replace("px", ""));

  return currentMarginTop;
};
