"use client";

import { AIChatPlugin } from "@platejs/ai/react";
import { BlockSelectionPlugin } from "@platejs/selection/react";
import { WaveformIcon as AudioLinesIcon } from "@phosphor-icons/react/dist/ssr/Waveform"
import { CalendarIcon as CalendarIcon } from "@phosphor-icons/react/dist/ssr/Calendar"
import { BookOpenTextIcon as BookOpenTextIcon } from "@phosphor-icons/react/dist/ssr/BookOpenText"
import { CaretDownIcon as ChevronDownIcon } from "@phosphor-icons/react/dist/ssr/CaretDown"
import { CodeIcon as Code2Icon } from "@phosphor-icons/react/dist/ssr/Code"
import { FileArrowUpIcon as FileUpIcon } from "@phosphor-icons/react/dist/ssr/FileArrowUp"
import { FilmStripIcon as FilmIcon } from "@phosphor-icons/react/dist/ssr/FilmStrip"
import { TextHOneIcon as Heading1Icon } from "@phosphor-icons/react/dist/ssr/TextHOne"
import { TextHTwoIcon as Heading2Icon } from "@phosphor-icons/react/dist/ssr/TextHTwo"
import { TextHThreeIcon as Heading3Icon } from "@phosphor-icons/react/dist/ssr/TextHThree"
import { TextHFourIcon as Heading4Icon } from "@phosphor-icons/react/dist/ssr/TextHFour"
import { TextHFiveIcon as Heading5Icon } from "@phosphor-icons/react/dist/ssr/TextHFive"
import { TextHSixIcon as Heading6Icon } from "@phosphor-icons/react/dist/ssr/TextHSix"
import { ImageIcon as ImageIcon } from "@phosphor-icons/react/dist/ssr/Image"
import { LightbulbIcon as LightbulbIcon } from "@phosphor-icons/react/dist/ssr/Lightbulb"
import { ListIcon as ListIcon } from "@phosphor-icons/react/dist/ssr/List"
import { ListNumbersIcon as ListOrderedIcon } from "@phosphor-icons/react/dist/ssr/ListNumbers"
import { ParagraphIcon as PilcrowIcon } from "@phosphor-icons/react/dist/ssr/Paragraph"
import { QuotesIcon as QuoteIcon } from "@phosphor-icons/react/dist/ssr/Quotes"
import { RadicalIcon as RadicalIcon } from "@phosphor-icons/react/dist/ssr/Radical"
import { RectangleIcon as RectangleVerticalIcon } from "@phosphor-icons/react/dist/ssr/Rectangle"
import { SquareIcon as SquareIcon } from "@phosphor-icons/react/dist/ssr/Square"
import { TableIcon as TableIcon } from "@phosphor-icons/react/dist/ssr/Table"
import { ListBulletsIcon as TableOfContentsIcon } from "@phosphor-icons/react/dist/ssr/ListBullets"
import { SparkleIcon } from "@phosphor-icons/react/dist/ssr/Sparkle";
import { cn } from "../lib/utils";
import type { IconProps } from "@phosphor-icons/react";
import { KEYS } from "platejs";
import type { PlateEditor, PlateElementProps } from "platejs/react";
import { PlateElement } from "platejs/react";
import type { ReactNode } from "react";

import {
  insertBlock,
  insertInlineElement,
  setBlockType,
} from "../components/transforms";
import { blockMenuItems } from "./block-menu";

import {
  backgroundColorItems,
  ColorIcon,
  textColorItems,
} from "./font-color-toolbar-button";
import {
  InlineCombobox,
  InlineComboboxContent,
  InlineComboboxEmpty,
  InlineComboboxGroup,
  InlineComboboxGroupLabel,
  InlineComboboxInput,
  InlineComboboxItem,
} from "./inline-combobox";
import { turnIntoItems } from "./turn-into-toolbar-button";

interface SlashItem {
  icon: ReactNode;
  value: string;
  onSelect: (editor: PlateEditor, value: string) => void;
  description?: string;
  focusEditor?: boolean;
  keywords?: string[];
  label?: string;
}

interface Group {
  group: string;
  /**
   * Optional per-editor gate: the group renders only when this returns true
   * (e.g. only in editors that registered a required plugin). Ungated groups
   * always render.
   */
  when?: (editor: PlateEditor) => boolean;
  items: SlashItem[];
}

/**
 * Runtime slash-group extension points: the chat composer surface sets
 * `__canvasComposerSlashGroups` (cleared/replaced per composer mount), while
 * app document-editor kits register durable groups on
 * `__canvasEditorSlashGroups` (module-scope, typically gated via `when`).
 */
function getRuntimeSlashGroups(): Group[] {
  const scope = globalThis as {
    __canvasComposerSlashGroups?: Group[];
    __canvasEditorSlashGroups?: Group[];
  };

  return [
    ...(scope.__canvasComposerSlashGroups ?? []),
    ...(scope.__canvasEditorSlashGroups ?? []),
  ];
}

/** The AI mark: Phosphor's sparkle in the accent color. */
function AIIcon({ className, ...props }: IconProps) {
  return <SparkleIcon className={cn("text-primary", className)} {...props} />;
}

const groups: Group[] = [
  {
    group: "AI",
    when: (editor) => Boolean(editor.plugins[KEYS.aiChat]),
    items: [
      {
        description: "Use AI to generate content.",
        focusEditor: false,
        icon: <AIIcon />,
        keywords: ["ai", "generate", "help", "chat"],
        value: "AI",
        onSelect: (editor) => {
          editor.getApi(AIChatPlugin).aiChat.show();
        },
      },
    ],
  },
  {
    group: "Basic blocks",
    items: [
      {
        description: "Plain text.",
        icon: <PilcrowIcon />,
        keywords: ["paragraph"],
        label: "Text",
        value: KEYS.p,
      },
      {
        description: "Large section heading.",
        icon: <Heading1Icon />,
        keywords: ["title", "h1"],
        label: "Heading 1",
        value: KEYS.h1,
      },
      {
        description: "Medium section heading.",
        icon: <Heading2Icon />,
        keywords: ["subtitle", "h2"],
        label: "Heading 2",
        value: KEYS.h2,
      },
      {
        description: "Small section heading.",
        icon: <Heading3Icon />,
        keywords: ["subtitle", "h3"],
        label: "Heading 3",
        value: KEYS.h3,
      },
      {
        description: "Fourth-level section heading.",
        icon: <Heading4Icon />,
        keywords: ["heading", "h4"],
        label: "Heading 4",
        value: KEYS.h4,
      },
      {
        description: "Fifth-level section heading.",
        icon: <Heading5Icon />,
        keywords: ["heading", "h5"],
        label: "Heading 5",
        value: KEYS.h5,
      },
      {
        description: "Sixth-level section heading.",
        icon: <Heading6Icon />,
        keywords: ["heading", "h6"],
        label: "Heading 6",
        value: KEYS.h6,
      },
      {
        description: "Create a bulleted list.",
        icon: <ListIcon />,
        keywords: ["unordered", "ul", "-"],
        label: "Bulleted list",
        value: KEYS.ul,
      },
      {
        description: "Create a numbered list.",
        icon: <ListOrderedIcon />,
        keywords: ["ordered", "ol", "1"],
        label: "Numbered list",
        value: KEYS.ol,
      },
      {
        description: "Insert a checklist for tasks.",
        icon: <SquareIcon />,
        keywords: ["checklist", "task", "checkbox", "[]"],
        label: "To-do list",
        value: KEYS.listTodo,
      },
      {
        description: "Insert a collapsible section.",
        icon: <ChevronDownIcon />,
        keywords: ["collapsible", "expandable"],
        label: "Toggle",
        value: KEYS.toggle,
      },
      {
        description: "Insert a block for code.",
        icon: <Code2Icon />,
        keywords: ["```"],
        label: "Code Block",
        value: KEYS.codeBlock,
      },
      {
        description: "Create a table for data.",
        icon: <TableIcon />,
        label: "Table",
        value: KEYS.table,
      },
      {
        description: "Insert a quote for emphasis.",
        icon: <QuoteIcon />,
        keywords: ["citation", "blockquote", "quote", ">"],
        label: "Blockquote",
        value: KEYS.blockquote,
      },
      {
        description: "Insert a highlighted block.",
        icon: <LightbulbIcon />,
        keywords: ["note"],
        label: "Callout",
        value: KEYS.callout,
      },
    ].map((item) => ({
      ...item,
      onSelect: (editor, value) => {
        insertBlock(editor, value);
      },
    })),
  },
  {
    group: "Media",
    items: [
      {
        description: "Upload or embed an image.",
        icon: <ImageIcon />,
        keywords: ["media", "img", "picture", "photo"],
        label: "Image",
        value: KEYS.img,
      },
      {
        description: "Upload or embed a video.",
        icon: <FilmIcon />,
        keywords: ["media", "video", "movie"],
        label: "Video",
        value: KEYS.video,
      },
      {
        description: "Upload or embed audio.",
        icon: <AudioLinesIcon />,
        keywords: ["media", "audio", "sound"],
        label: "Audio",
        value: KEYS.audio,
      },
      {
        description: "Upload or link any file type.",
        icon: <FileUpIcon />,
        keywords: ["media", "file", "document", "attachment"],
        label: "File",
        value: KEYS.file,
      },
    ].map((item) => ({
      ...item,
      focusEditor: false,
      onSelect: (editor, value) => {
        insertBlock(editor, value);
      },
    })),
  },
  {
    group: "Advanced blocks",
    items: [
      {
        description: "Generate a table of contents.",
        icon: <TableOfContentsIcon />,
        keywords: ["toc"],
        label: "Table of content",
        value: KEYS.toc,
      },
      {
        description: "Insert a block for equations.",
        focusEditor: false,
        icon: <RadicalIcon />,
        keywords: ["math", "formula"],
        label: "Equation",
        value: KEYS.equation,
      },
      {
        description: "Create 3 columns of blocks.",
        icon: <RectangleVerticalIcon />,
        label: "3 columns",
        value: "action_three_columns",
      },
    ].map((item) => ({
      ...item,
      onSelect: (editor, value) => {
        insertBlock(editor, value);
      },
    })),
  },
  {
    group: "Inline",
    items: [
      {
        description: "Insert an inline math equation.",
        focusEditor: false,
        icon: <RadicalIcon />,
        keywords: ["math", "inline", "formula"],
        label: "Inline Equation",
        value: KEYS.inlineEquation,
      },
      {
        description: "Insert current or custom date.",
        focusEditor: true,
        icon: <CalendarIcon />,
        keywords: ["time"],
        label: "Date",
        value: KEYS.date,
      },
    ].map((item) => ({
      ...item,
      onSelect: (editor, value) => {
        insertInlineElement(editor, value);
      },
    })),
  },
  {
    group: "References",
    when: (editor) => Boolean(editor.plugins[KEYS.footnoteReference]),
    items: [
      {
        description: "Insert a linked footnote and definition.",
        focusEditor: false,
        icon: <BookOpenTextIcon />,
        keywords: ["reference", "citation", "note"],
        label: "Footnote",
        value: KEYS.footnoteReference,
        onSelect: (editor, value) => insertInlineElement(editor, value),
      },
    ],
  },
  {
    group: "Turn into",
    items: turnIntoItems.map((item) => ({
      ...item,
      onSelect: (editor) => {
        setBlockType(editor, item.value);
      },
    })),
  },
  {
    group: "Actions",
    items: [
      {
        ...blockMenuItems.delete,
        onSelect: (editor) => {
          editor.tf.removeNodes();
        },
      },
      {
        ...blockMenuItems.duplicate,
        onSelect: (editor) => {
          editor.getTransforms(BlockSelectionPlugin).blockSelection.duplicate();
        },
      },
    ],
  },
  {
    group: "Text color",
    items: textColorItems.map((item) => ({
      ...item,
      icon: <ColorIcon group="color" value={item.value} />,
      onSelect: (editor) => {
        editor.tf.setNodes(
          { color: item.value },
          { at: editor.api.block()?.[1], mode: "lowest" }
        );
      },
    })),
  },
  {
    group: "Background color",
    items: backgroundColorItems.map((item) => ({
      ...item,
      icon: <ColorIcon group="background" value={item.value} />,
      onSelect: (editor) => {
        editor.tf.setNodes(
          { backgroundColor: item.value },
          { at: editor.api.block()?.[1] }
        );
      },
    })),
  },
];

export function SlashInputElement(props: PlateElementProps) {
  const { children, editor, element } = props;
  const mergedGroups = [...groups, ...getRuntimeSlashGroups()].filter(
    (group) => !group.when || group.when(editor)
  );

  return (
    <PlateElement {...props} as="span">
      <InlineCombobox element={element} trigger="/">
        <InlineComboboxInput />

        <InlineComboboxContent variant="slash">
          <InlineComboboxEmpty>No results</InlineComboboxEmpty>

          {mergedGroups.map(({ group, items }) => (
            <InlineComboboxGroup key={group}>
              <InlineComboboxGroupLabel>{group}</InlineComboboxGroupLabel>
              {items.map(
                ({
                  description,
                  focusEditor,
                  icon,
                  keywords,
                  label,
                  value,
                  onSelect,
                }) => (
                  <InlineComboboxItem
                    focusEditor={focusEditor}
                    group={group}
                    key={value}
                    keywords={keywords}
                    label={label}
                    onClick={() => onSelect(editor, value)}
                    value={value}
                  >
                    {description ? (
                      <>
                        <div className="flex size-11 items-center justify-center rounded border border-foreground/15 bg-background [&_svg]:size-5 [&_svg]:text-muted-foreground">
                          {icon}
                        </div>
                        <div className="ml-3 flex flex-1 flex-col truncate">
                          <span>{label ?? value}</span>
                          <span className="truncate text-muted-foreground text-xs">
                            {description}
                          </span>
                        </div>
                      </>
                    ) : (
                      <>
                        <div className="mr-2 text-muted-foreground">
                          {icon}
                        </div>
                        {label ?? value}
                      </>
                    )}
                  </InlineComboboxItem>
                )
              )}
            </InlineComboboxGroup>
          ))}
        </InlineComboboxContent>
      </InlineCombobox>

      {children}
    </PlateElement>
  );
}

// Export the groups as slashItems for external use
export const slashItems = groups;

/** The slash-menu group shape, for runtime group registration by app kits. */
export type SlashGroup = Group;

// SlashMenu component - a standalone menu for slash commands
export function SlashMenu({
  editor,
  children,
}: {
  editor: PlateEditor;
  children?: React.ReactNode;
}) {
  const mergedGroups = [...groups, ...getRuntimeSlashGroups()].filter(
    (group) => !group.when || group.when(editor)
  );

  return (
    <div className="flex flex-col">
      {children ?? (
        <InlineComboboxContent variant="slash">
          <InlineComboboxEmpty>No results</InlineComboboxEmpty>
          {mergedGroups.map(({ group, items }) => (
            <InlineComboboxGroup key={group}>
              <InlineComboboxGroupLabel>{group}</InlineComboboxGroupLabel>
              {items.map(
                ({
                  description,
                  focusEditor,
                  icon,
                  keywords,
                  label,
                  value,
                  onSelect,
                }) => (
                  <InlineComboboxItem
                    focusEditor={focusEditor}
                    group={group}
                    key={value}
                    keywords={keywords}
                    label={label}
                    onClick={() => onSelect(editor, value)}
                    value={value}
                  >
                    {description ? (
                      <>
                        <div className="flex size-11 items-center justify-center rounded border border-foreground/15 bg-background [&_svg]:size-5 [&_svg]:text-muted-foreground">
                          {icon}
                        </div>
                        {label ?? value}
                      </>
                    ) : (
                      <>
                        {icon}
                        {label ?? value}
                      </>
                    )}
                  </InlineComboboxItem>
                )
              )}
            </InlineComboboxGroup>
          ))}
        </InlineComboboxContent>
      )}
    </div>
  );
}
