"use client";

import { AIChatPlugin } from "@platejs/ai/react";
import { showCaption } from "@platejs/caption/react";
import { getDraftCommentKey } from "@platejs/comment";
import {
  BlockMenuPlugin,
  BlockSelectionPlugin,
  useBlockSelectionFragmentProp,
  useBlockSelectionNodes,
} from "@platejs/selection/react";
import { TextAlignCenterIcon as AlignCenter } from "@phosphor-icons/react/dist/ssr/TextAlignCenter"
import { TextAlignLeftIcon as AlignLeft } from "@phosphor-icons/react/dist/ssr/TextAlignLeft"
import { TextAlignRightIcon as AlignRight } from "@phosphor-icons/react/dist/ssr/TextAlignRight"
import { ClosedCaptioningIcon as CaptionsIcon } from "@phosphor-icons/react/dist/ssr/ClosedCaptioning"
import { FilesIcon as FilesIcon } from "@phosphor-icons/react/dist/ssr/Files"
import { ChatTextIcon as MessageSquareText } from "@phosphor-icons/react/dist/ssr/ChatText"
import { PaintRollerIcon as PaintRoller } from "@phosphor-icons/react/dist/ssr/PaintRoller"
import { ArrowsClockwiseIcon as RefreshCwIcon } from "@phosphor-icons/react/dist/ssr/ArrowsClockwise"
import { TrashIcon as Trash2 } from "@phosphor-icons/react/dist/ssr/Trash"
import { SparkleIcon } from "@phosphor-icons/react/dist/ssr/Sparkle";
import { cn } from "../lib/utils";
import type { IconProps } from "@phosphor-icons/react";
import { KEYS, type TElement } from "platejs";
import { type PlateEditor, useEditorRef, useHotkeys } from "platejs/react";
import { type ComponentType, type ReactNode, useMemo, useState } from "react";
import { getBlockType, setBlockType } from "../components/transforms";
import { commentPlugin } from "../plugins/comment-kit";
import {
  backgroundColorItems,
  ColorIcon,
  textColorItems,
} from "./font-color-toolbar-button";
import { Input } from "./input";
import {
  type Action,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxList,
  filterMenuGroups,
  filterMenuItems,
  Menu,
  MenuContent,
  type MenuContentProps,
  MenuGroup,
  MenuItem,
  type MenuProps,
  MenuTrigger,
  useComboboxValueState,
} from "./menu";
import { turnIntoItems } from "./turn-into-toolbar-button";

type EditorActionContext = {
  editor: PlateEditor;
};

const MEDIA_BLOCK_TYPES = new Set<string>([
  KEYS.audio,
  KEYS.file,
  KEYS.img,
  KEYS.mediaEmbed,
  KEYS.video,
]);

type BlockMenuItemDefinition = Action & {
  component?: ComponentType;
  focusEditor?: boolean;
  onSelect?: ({ editor }: EditorActionContext) => void;
  shortcut?: string;
};

export function BlockMenu({
  id,
  animateZoom,
  children,
  getAnchorRect,
  open: openProp,
  placement,
  store,
}: Pick<MenuProps, "open" | "placement" | "store"> &
  Pick<MenuContentProps, "animateZoom" | "getAnchorRect"> & {
    id?: string;
    children?: ReactNode;
  }) {
  const editor = useEditorRef();
  const [open, setOpen] = useState(false);

  return (
    <Menu
      onOpenChange={(isOpen) => {
        setOpen(isOpen);

        if (!isOpen) {
          editor.getApi(BlockMenuPlugin).blockMenu.hide();
        } else if (id) {
          editor.getApi(BlockMenuPlugin).blockMenu.show(id);
        }
      }}
      open={openProp ?? open}
      placement={placement}
      store={store}
      trigger={children ? <MenuTrigger>{children}</MenuTrigger> : undefined}
    >
      <MenuContent
        animateZoom={animateZoom}
        autoFocusOnHide={false}
        getAnchorRect={getAnchorRect}
        portal
        preventBodyScroll={!children}
      >
        <ComboboxContent>
          <BlockMenuInput
            onHide={() => {
              setOpen(false);
              editor.getApi(BlockMenuPlugin).blockMenu.hide();
            }}
          />
        </ComboboxContent>

        <ComboboxList>
          <ComboboxEmpty />

          <BlockMenuItems />
        </ComboboxList>
      </MenuContent>
    </Menu>
  );
}

function BlockMenuInput({ onHide }: { onHide: () => void }) {
  const editor = useEditorRef();
  const blockSelectionTf =
    editor.getTransforms(BlockSelectionPlugin).blockSelection;
  const [value] = useComboboxValueState();

  useHotkeys(
    "backspace",
    (e) => {
      if (value.length === 0) {
        e.preventDefault();
        blockSelectionTf.removeNodes();
        onHide();
      }
    },
    { enableOnFormTags: true }
  );

  useHotkeys(
    "meta+d",
    (e) => {
      if (value.length === 0) {
        e.preventDefault();
        blockSelectionTf.duplicate();
        onHide();
      }
    },
    { enableOnFormTags: true }
  );

  useHotkeys(
    "meta+j",
    () => {
      onHide();
    },
    { enableOnFormTags: true }
  );

  return (
    <ComboboxInput>
      <Input placeholder="Search actions..." />
    </ComboboxInput>
  );
}

/** The AI mark: Phosphor's sparkle in the accent color. */
function AIIcon({ className, ...props }: IconProps) {
  return <SparkleIcon className={cn("text-primary", className)} {...props} />;
}

const GROUP = {
  ALIGN: "align",
  BACKGROUND: "background",
  COLOR: "color",
  TURN_INTO: "turn_into",
} as const;

export const blockMenuItems = {
  askAI: {
    focusEditor: false,
    icon: <AIIcon />,
    keywords: ["generate", "help", "chat"],
    label: "Ask AI",
    shortcut: "⌘+J",
    value: "askAI",
    onSelect: ({ editor }: EditorActionContext) => {
      editor.getApi(AIChatPlugin).aiChat.show();
    },
  },
  caption: {
    icon: <CaptionsIcon />,
    keywords: ["alt"],
    label: "Caption",
    value: "caption",
    onSelect: ({ editor }: EditorActionContext) => {
      const firstBlock = editor
        .getApi(BlockSelectionPlugin)
        .blockSelection.getNodes()[0];
      showCaption(editor, firstBlock[0] as TElement);
      editor.getApi(BlockSelectionPlugin).blockSelection.clear();
    },
  },
  comment: {
    icon: <MessageSquareText />,
    keywords: ["note", "feedback", "annotation"],
    label: "Comment",
    shortcut: "⌘+Shift+M",
    value: "comment",
    onSelect: ({ editor }: { editor: PlateEditor }) => {
      setTimeout(() => {
        editor.getTransforms(BlockSelectionPlugin).blockSelection.select();
        editor.getTransforms(commentPlugin).comment.setDraft();
        editor.tf.collapse();
        editor.setOption(commentPlugin, "activeId", getDraftCommentKey());
        editor.setOption(
          commentPlugin,
          "commentingBlock",
          editor.selection?.focus.path.slice(0, 1) ?? null
        );
      }, 0);
    },
  },
  copyLink: {
    icon: <FilesIcon />,
    keywords: ["link", "anchor", "copy"],
    label: "Copy link to block",
    value: "copyLink",
    onSelect: ({ editor }: EditorActionContext) => {
      const nodes = editor
        .getApi(BlockSelectionPlugin)
        .blockSelection.getNodes();
      const first = nodes?.[0]?.[0] as TElement | undefined;
      const id = (first as (TElement & { id?: string }) | undefined)?.id;

      if (!id) return;

      try {
        const url = new URL(window.location.href);
        // keep only pathname + search
        const href = `${url.pathname + (url.search || "")}#${id}`;
        navigator.clipboard.writeText(href).catch(() => {
          // Clipboard access can fail in unsupported or test environments.
        });
      } catch {
        // Ignore invalid URL environments.
      }
    },
  },
  delete: {
    icon: <Trash2 />,
    keywords: ["remove"],
    label: "Delete",
    shortcut: "Del or Ctrl+D",
    value: "delete",
    onSelect: ({ editor }: EditorActionContext) => {
      editor.getTransforms(BlockSelectionPlugin).blockSelection.removeNodes();
    },
  },
  duplicate: {
    focusEditor: false,
    icon: <FilesIcon />,
    keywords: ["copy"],
    label: "Duplicate",
    shortcut: "⌘+D",
    value: "duplicate",
    onSelect: ({ editor }: EditorActionContext) => {
      editor.getTransforms(BlockSelectionPlugin).blockSelection.duplicate();

      editor.getApi(BlockSelectionPlugin).blockSelection.focus();
    },
  },
  [GROUP.ALIGN]: {
    component: AlignMenuItem,
    filterItems: true,
    icon: <AlignLeft />,
    items: [
      { icon: <AlignLeft />, label: "Left", value: "left" },
      { icon: <AlignCenter />, label: "Center", value: "center" },
      { icon: <AlignRight />, label: "Right", value: "right" },
    ],
    label: "Align",
    value: GROUP.ALIGN,
  },
  [GROUP.COLOR]: {
    component: ColorMenuItem,
    filterItems: true,
    icon: <PaintRoller />,
    items: [
      { group: GROUP.COLOR, items: textColorItems, label: "Text color" },
      {
        group: GROUP.BACKGROUND,
        items: backgroundColorItems,
        label: "Background color",
      },
    ],
    keywords: ["highlight", "background"],
    label: "Color",
    value: GROUP.COLOR,
  },
  [GROUP.TURN_INTO]: {
    component: TurnIntoMenuItem,
    filterItems: true,
    icon: <RefreshCwIcon />,
    items: turnIntoItems,
    label: "Turn into",
    value: GROUP.TURN_INTO,
  },
};

const blockMenuItemRegistry = blockMenuItems as Record<
  string,
  BlockMenuItemDefinition
>;

const orderedMenuItems = [
  {
    items: [blockMenuItems.comment],
  },
  {
    items: [
      blockMenuItems.askAI,
      blockMenuItems.copyLink,
      blockMenuItems.delete,
      blockMenuItems.duplicate,
      blockMenuItems[GROUP.TURN_INTO],
    ],
  },
  {
    items: [blockMenuItems[GROUP.COLOR]],
  },
  {
    items: [{ label: "Synced", value: "synced" }],
  },
];

const mediaMenuItems = [
  {
    items: [blockMenuItems.comment, blockMenuItems.caption],
  },
  {
    items: [blockMenuItems[GROUP.ALIGN]],
  },
  {
    items: [blockMenuItems.delete, blockMenuItems.duplicate],
  },
];

function BlockMenuItems() {
  const [searchValue] = useComboboxValueState();
  const selectedBlocks = useBlockSelectionNodes();
  const editor = useEditorRef();
  const hasAI = Boolean(editor.plugins[AIChatPlugin.key]);
  const hasComment = Boolean(editor.plugins[KEYS.comment]);

  const menuGroups = useMemo(() => {
    const isMedia =
      selectedBlocks.length === 1 &&
      selectedBlocks.some((item) =>
        MEDIA_BLOCK_TYPES.has(String(item[0].type))
      );

    // Ask AI and Comment call their plugin's API, which an editor without it lacks.
    const items = (isMedia ? mediaMenuItems : orderedMenuItems).map(
      (group) => ({
        ...group,
        items: group.items.filter(
          (item) =>
            (hasAI || item !== blockMenuItems.askAI) &&
            (hasComment || item !== blockMenuItems.comment)
        ),
      })
    );

    return filterMenuGroups(items, searchValue) || items;
  }, [hasAI, hasComment, selectedBlocks, searchValue]);

  return (
    <>
      {menuGroups.map((group) => (
        <MenuGroup
          key={
            group.group ??
            group.label ??
            group.items
              ?.map((item) => item.value ?? item.label ?? "item")
              .join("-")
          }
          label={group.label}
        >
          {group.items?.map((item: Action) => {
            if (!item.value) {
              return null;
            }

            const menuItem = blockMenuItemRegistry[item.value];

            if (menuItem.component) {
              const ItemComponent = menuItem.component;

              return <ItemComponent key={item.value} />;
            }

            return (
              <MenuItem
                icon={menuItem.icon}
                key={item.value}
                label={menuItem.label}
                onClick={() => {
                  menuItem.onSelect?.({ editor });

                  if (menuItem.focusEditor !== false) editor.tf.focus();
                }}
                shortcut={menuItem.shortcut}
              />
            );
          })}
        </MenuGroup>
      ))}
    </>
  );
}

function ColorMenuItem() {
  const [searchValue] = useComboboxValueState();
  const editor = useEditorRef();

  const color = useBlockSelectionFragmentProp({
    key: KEYS.color,
    defaultValue: "inherit",
    mode: "text",
  });
  const background = useBlockSelectionFragmentProp({
    key: KEYS.backgroundColor,
    defaultValue: "transparent",
  });

  const handleColorChange = (group: string, value: string) => {
    if (group === GROUP.COLOR) {
      editor
        .getTransforms(BlockSelectionPlugin)
        .blockSelection.setNodes({ color: value });
    } else if (group === GROUP.BACKGROUND) {
      editor
        .getTransforms(BlockSelectionPlugin)
        .blockSelection.setNodes({ backgroundColor: value });
    }

    editor.getApi(BlockSelectionPlugin).blockSelection.focus();
  };

  const menuGroups = useMemo(
    () => filterMenuGroups(blockMenuItems[GROUP.COLOR].items, searchValue),
    [searchValue]
  );

  const content = (
    <>
      {menuGroups.map((menuGroup) => (
        <MenuGroup key={menuGroup.group} label={menuGroup.label}>
          {menuGroup.items?.map((item) => {
            const group = menuGroup.group;
            const itemValue = item.value;
            if (!(group && itemValue)) {
              return null;
            }

            return (
              <MenuItem
                checked={
                  group === GROUP.COLOR
                    ? color === itemValue
                    : background === itemValue
                }
                icon={<ColorIcon group={group} value={itemValue} />}
                key={itemValue}
                label={item.label}
                onClick={() => handleColorChange(group, itemValue)}
              />
            );
          })}
        </MenuGroup>
      ))}
    </>
  );

  if (searchValue) return content;

  return (
    <Menu
      placement="right"
      trigger={
        <MenuTrigger
          icon={blockMenuItems[GROUP.COLOR].icon}
          label={blockMenuItems[GROUP.COLOR].label}
        />
      }
    >
      <MenuContent portal>{content}</MenuContent>
    </Menu>
  );
}

function AlignMenuItem() {
  const [searchValue] = useComboboxValueState();
  const editor = useEditorRef();
  const value = useBlockSelectionFragmentProp({
    key: "align",
    defaultValue: "left",
  });

  const menuItems = useMemo(
    () => filterMenuItems(blockMenuItems[GROUP.ALIGN], searchValue),
    [searchValue]
  );

  const content = (
    <>
      {menuItems.map((item) => (
        <MenuItem
          checked={value === item.value}
          icon={item.icon}
          key={item.value}
          label={item.label}
          onClick={() => {
            editor
              .getTransforms(BlockSelectionPlugin)
              .blockSelection.setNodes({ align: item.value });
            editor.tf.focus();
          }}
        />
      ))}
    </>
  );

  if (searchValue)
    return (
      <MenuGroup label={blockMenuItems[GROUP.ALIGN].label}>{content}</MenuGroup>
    );

  return (
    <Menu
      placement="right"
      trigger={
        <MenuTrigger
          icon={blockMenuItems[GROUP.ALIGN].icon}
          label={blockMenuItems[GROUP.ALIGN].label}
        />
      }
    >
      <MenuContent portal>
        <MenuGroup>{content}</MenuGroup>
      </MenuContent>
    </Menu>
  );
}

function TurnIntoMenuItem() {
  const editor = useEditorRef();
  const [searchValue] = useComboboxValueState();

  const selectedBlockType = useBlockSelectionFragmentProp({
    defaultValue: KEYS.p,
    getProp: (node) => getBlockType(node as TElement),
  });

  const handleTurnInto = (blockType: string) => {
    editor
      .getApi(BlockSelectionPlugin)
      .blockSelection.getNodes()
      .forEach(([, path]) => {
        setBlockType(editor, blockType, { at: path });
      });
    editor.getApi(BlockSelectionPlugin).blockSelection.focus();
  };

  const menuItems = useMemo(
    () => filterMenuItems(blockMenuItems[GROUP.TURN_INTO], searchValue),
    [searchValue]
  );

  const content = (
    <>
      {menuItems.map((item) => {
        const itemValue = item.value;
        if (!itemValue) {
          return null;
        }

        return (
          <MenuItem
            checked={selectedBlockType === itemValue}
            icon={
              <div className="flex size-5 items-center justify-center rounded-md border border-foreground/15 bg-background p-0.5 text-muted-foreground [&_svg]:size-3">
                {item.icon}
              </div>
            }
            key={itemValue}
            label={item.label}
            onClick={() => handleTurnInto(itemValue)}
          />
        );
      })}
    </>
  );

  if (searchValue)
    return (
      <MenuGroup label={blockMenuItems[GROUP.TURN_INTO].label}>
        {content}
      </MenuGroup>
    );

  return (
    <Menu
      placement="right"
      trigger={
        <MenuTrigger
          icon={blockMenuItems[GROUP.TURN_INTO].icon}
          label={blockMenuItems[GROUP.TURN_INTO].label}
        />
      }
    >
      <MenuContent portal>
        <MenuGroup>{content}</MenuGroup>
      </MenuContent>
    </Menu>
  );
}

/**
 * SyncedMenuItem - Placeholder for synced block menu functionality.
 *
 * This is a basic implementation. For full synced block operations
 * (create, insert, refresh, update), override this in your application
 * with proper API integration.
 */
function SyncedMenuItem() {
  return null;
}

// Register the synced menu item
(blockMenuItems as Record<string, unknown>).synced = {
  component: SyncedMenuItem,
};
