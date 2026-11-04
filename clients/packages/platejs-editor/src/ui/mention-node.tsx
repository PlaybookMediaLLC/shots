"use client";

import { DatePlugin } from "@platejs/date/react";
import { MentionPlugin } from "@platejs/mention/react";
import { cn } from "@udecode/cn";
import { ArrowUpRightIcon as ArrowUpRightIcon } from "@phosphor-icons/react/dist/ssr/ArrowUpRight"
import { FileTextIcon as FileTextIcon } from "@phosphor-icons/react/dist/ssr/FileText";
import { IS_APPLE, type TText, type Value } from "platejs";
import {
  PlateElement,
  type PlateElementProps,
  useEditorRef,
  useFocused,
  useHotkeys,
  usePlateEditor,
  useReadOnly,
  useSelected,
} from "platejs/react";
import { useEffect, useMemo, useState } from "react";
import { useMounted } from "react-tweet";
import { BaseEditorKit } from "../components/editor-base-kit";
import type { MyMentionElement } from "../components/plate-types";
import { insertInlineElement } from "../components/transforms";
import { useDebounce } from "../hooks/use-debounce";

import { Avatar, AvatarFallback, AvatarImage } from "./avatar";
import { EditorStatic } from "./editor-static";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "./hover-card";
import {
  InlineCombobox,
  InlineComboboxContent,
  InlineComboboxEmpty,
  InlineComboboxGroup,
  InlineComboboxGroupLabel,
  InlineComboboxInput,
  InlineComboboxItem,
} from "./inline-combobox";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "./tooltip";

type DocumentItem = {
  id: string;
  contentRich: {
    children: { text: string }[];
    type: string;
  }[];
  coverImage: string;
  icon: string;
  title: string;
};

type PeopleComboboxGroupProps = {
  search: string;
  onUserHover: (name: string) => void;
  onUserSelect: (user: UserItem) => void;
};

export const mockMentionDocuments = [
  {
    id: "docs/examples/ai",
    contentRich: [
      {
        children: [
          {
            text: "A comprehensive guide to using AI features in your documents.",
          },
        ],
        type: "p",
      },
    ],
    coverImage: "https://picsum.photos/seed/ai/800/400",
    icon: "📋",
    title: "AI",
  },
  {
    id: "docs/examples/callout",
    contentRich: [
      {
        children: [
          {
            text: "Learn how to use callouts to highlight important information.",
          },
        ],
        type: "p",
      },
    ],
    coverImage: "https://picsum.photos/seed/callout/800/400",
    icon: "🧰",
    title: "Callout",
  },
  {
    id: "docs/examples/equation",
    contentRich: [
      {
        children: [
          { text: "Everything you need to know about mathematical equations." },
        ],
        type: "p",
      },
    ],
    coverImage: "https://picsum.photos/seed/equation/800/400",
    icon: "🧮",
    title: "Equation",
  },
  {
    id: "docs/examples/toc",
    contentRich: [
      {
        children: [
          {
            text: "How to create and manage table of contents in your documents.",
          },
        ],
        type: "p",
      },
    ],
    coverImage: "https://picsum.photos/seed/toc/800/400",
    icon: "📚",
    title: "Table of Contents",
  },
];

type UserItem = {
  id: string;
  email: string;
  name: string;
  profileImageUrl: string;
};

const mockUsers = [
  {
    id: "1",
    email: "john@example.com",
    name: "John Doe",
    profileImageUrl: "https://api.dicebear.com/7.x/avataaars/svg?seed=John",
  },
  {
    id: "2",
    email: "jane@example.com",
    name: "Jane Smith",
    profileImageUrl: "https://api.dicebear.com/7.x/avataaars/svg?seed=Jane",
  },
  {
    id: "3",
    email: "bob@example.com",
    name: "Bob Wilson",
    profileImageUrl: "https://api.dicebear.com/7.x/avataaars/svg?seed=Bob",
  },
  {
    id: "4",
    email: "alice@example.com",
    name: "Alice Brown",
    profileImageUrl: "https://api.dicebear.com/7.x/avataaars/svg?seed=Alice",
  },
  {
    id: "5",
    email: "charlie@example.com",
    name: "Charlie Davis",
    profileImageUrl: "https://api.dicebear.com/7.x/avataaars/svg?seed=Charlie",
  },
];

const getUserDisplayName = (user: UserItem) => user.name || user.email;

function getRuntimeMentionUsers(): UserItem[] {
  const runtimeUsers = (
    globalThis as {
      __canvasComposerMentionUsers?: Partial<UserItem>[];
    }
  ).__canvasComposerMentionUsers;

  if (!(runtimeUsers && runtimeUsers.length > 0)) {
    return mockUsers;
  }

  return runtimeUsers
    .map((user, index) => ({
      id: user.id ?? `runtime-user-${index}`,
      email: user.email ?? "",
      name: user.name ?? user.email ?? `User ${index + 1}`,
      profileImageUrl: user.profileImageUrl ?? "",
    }))
    .filter((user) => user.name.trim().length > 0);
}

export function MentionInputElement(props: PlateElementProps) {
  const [placeholder, setPlaceholder] = useState(
    "Mention a person,page,or date..."
  );

  const { children, editor, element } = props;
  const [search, setSearch] = useState(String(element.value ?? ""));

  return (
    <PlateElement {...props} as="span">
      <InlineCombobox
        element={element}
        setValue={(value) => {
          setSearch(value);
          const path = editor.api.findPath(element);
          if (path) editor.tf.setNodes({ value }, { at: path });
        }}
        showTrigger={false}
        trigger="@"
        value={search}
      >
        <span className="rounded-md bg-muted px-1.5 py-0.5 align-baseline text-sm ring-ring">
          <span className="font-bold">@</span>
          <InlineComboboxInput
            className="min-w-[100px]"
            placeholder={placeholder}
          />
        </span>

        <InlineComboboxContent variant="mention">
          <InlineComboboxEmpty>No results found</InlineComboboxEmpty>

          <InlineComboboxGroup>
            <InlineComboboxGroupLabel>Date</InlineComboboxGroupLabel>
            <InlineComboboxItem
              onClick={() => {
                insertInlineElement(editor, DatePlugin.key);
              }}
              onFocus={() => setPlaceholder("Today")}
              onMouseEnter={() => setPlaceholder("Today")}
              value="today"
            >
              <span>Today</span>
              <span className="mx-1 text-muted-foreground">—</span>
              <span className="font-medium text-muted-foreground text-xs">
                {new Date().toLocaleDateString(undefined, {
                  day: "numeric",
                  month: "long",
                  year: "numeric",
                })}
              </span>
            </InlineComboboxItem>
          </InlineComboboxGroup>

          <DocumentComboboxGroup
            onDocumentHover={(name) => setPlaceholder(name)}
            onDocumentSelect={(document) => {
              editor.tf.insertNodes<MyMentionElement>({
                key: `/${document.id}`,
                children: [{ text: "" }],
                coverImage: document.coverImage ?? undefined,
                icon: document.icon ?? undefined,
                type: MentionPlugin.key,
                value: document.title ?? "Untitled Document",
              });
              editor.tf.move({ unit: "offset" });
            }}
            search={search}
          />

          <PeopleComboboxGroup
            onUserHover={(name) => setPlaceholder(name)}
            onUserSelect={(user) => {
              editor.tf.insertNodes<MyMentionElement>({
                key: user.id,
                children: [{ text: "" }],
                type: MentionPlugin.key,
                value: getUserDisplayName(user),
              });
              editor.tf.move({ unit: "offset" });
            }}
            search={search}
          />
        </InlineComboboxContent>
      </InlineCombobox>
      {children}
    </PlateElement>
  );
}

type DocumentComboboxGroupProps = {
  search: string;
  onDocumentHover: (title: string) => void;
  onDocumentSelect: (document: DocumentItem) => void;
};

function PeopleComboboxGroup({
  search: searchRaw,
  onUserHover,
  onUserSelect,
}: PeopleComboboxGroupProps) {
  const search = useDebounce(searchRaw, 100);
  const [allUsers, setAllUsers] = useState<UserItem[]>([]);

  useEffect(() => {
    const filteredUsers = getRuntimeMentionUsers().filter(
      (user) =>
        user.name?.toLowerCase().includes(search.toLowerCase()) ||
        user.email?.toLowerCase().includes(search.toLowerCase())
    );
    setAllUsers(filteredUsers);
  }, [search]);

  if (allUsers.length === 0) {
    return null;
  }

  return (
    <InlineComboboxGroup>
      <InlineComboboxGroupLabel>People</InlineComboboxGroupLabel>

      {allUsers.map((user) => (
        <InlineComboboxItem
          key={user.id}
          onClick={() => onUserSelect(user)}
          onFocus={() => onUserHover(getUserDisplayName(user))}
          onMouseEnter={() => onUserHover(getUserDisplayName(user))}
          value={getUserDisplayName(user)}
        >
          <Avatar className="mr-2.5 size-5">
            <AvatarImage
              alt={getUserDisplayName(user)}
              src={user.profileImageUrl || undefined}
            />
            <AvatarFallback>
              {getUserDisplayName(user).charAt(0).toUpperCase()}
            </AvatarFallback>
          </Avatar>

          {getUserDisplayName(user)}
        </InlineComboboxItem>
      ))}
    </InlineComboboxGroup>
  );
}

function DocumentComboboxGroup({
  search: searchRaw,
  onDocumentHover,
  onDocumentSelect,
}: DocumentComboboxGroupProps) {
  const search = useDebounce(searchRaw, 500);
  const [allDocuments, setAllDocuments] = useState<DocumentItem[]>([]);

  useEffect(() => {
    // Filter mockDocuments based on search
    const filteredDocs = mockMentionDocuments.filter((doc) =>
      doc.title.toLowerCase().includes(search.toLowerCase())
    );
    setAllDocuments(filteredDocs);
  }, [search]);

  if (allDocuments.length === 0) {
    return null;
  }

  return (
    <InlineComboboxGroup>
      <InlineComboboxGroupLabel>Link to page</InlineComboboxGroupLabel>

      {allDocuments.map((document) => (
        <InlineComboboxItem
          key={document.id}
          onClick={() => onDocumentSelect(document)}
          onFocus={() => onDocumentHover(document.title ?? "")}
          onMouseEnter={() => onDocumentHover(document.title ?? "")}
          value={document.title || "Untitled Document"}
        >
          <span className="mr-2 size-5">
            {document.icon ?? <FileTextIcon />}
          </span>
          {document.title ?? "Untitled Document"}
        </InlineComboboxItem>
      ))}
    </InlineComboboxGroup>
  );
}

const openDocument = (id: string) => {
  const host = window.location.host;
  const baseUrl =
    // TODO: Remove this for demo only
    host === "eigenn.io" ? "https://eigenn.io" : window.location.origin;

  window.open(`${baseUrl}/${id}`, "_self");
};

function DocumentMentionElement(
  props: PlateElementProps<MyMentionElement> & {
    prefix?: string;
  }
) {
  const { children } = props;
  const element = props.element;
  const selected = useSelected();
  const focused = useFocused();
  const documentId = element.key?.slice(1);

  useHotkeys(
    "enter",
    () => {
      if (selected && focused && documentId) {
        openDocument(documentId);
      }
    },
    {
      enabled: selected && focused,
      enableOnContentEditable: true,
      enableOnFormTags: true,
    }
  );

  return (
    <TooltipProvider>
      <Tooltip open={selected && focused}>
        <HoverCard closeDelay={0} openDelay={0}>
          <HoverCardTrigger contentEditable={false}>
            <TooltipTrigger contentEditable={false}>
              <PlateElement
                {...props}
                attributes={{
                  ...props.attributes,
                  contentEditable: false,
                  "data-slate-value": element.value,
                  draggable: true,
                  onClick: () => {
                    if (documentId) {
                      openDocument(documentId);
                    }
                  },
                  onMouseDown: (e) => e.preventDefault(),
                }}
                className={cn(
                  "inline-block cursor-pointer rounded px-0.5 hover:bg-muted",
                  selected && focused && "bg-primary/25"
                )}
              >
                {props.prefix}
                <span className="relative mr-3 inline-block">
                  {element.icon}
                  <ArrowUpRightIcon className="absolute -right-3 bottom-0 size-3.5 font-bold" />
                </span>
                <span className="border-b-1 font-medium">{element.value}</span>
                {children}
              </PlateElement>
            </TooltipTrigger>
            <TooltipContent>
              <p>
                <span className="mr-1">Open Page</span>
                <kbd>↵</kbd>
              </p>
            </TooltipContent>
          </HoverCardTrigger>
          <HoverCardContent className="relative p-0 pb-4">
            <MentionHoverCardContent element={element} />
          </HoverCardContent>
        </HoverCard>
      </Tooltip>
    </TooltipProvider>
  );
}

function MentionHoverCardContent(props: { element: MyMentionElement }) {
  const editor = useEditorRef();
  const { element } = props;
  const documentId = element.key?.slice(1) ?? "";

  const isDocument = element.key?.startsWith("/") ?? false;

  // Find the document from mockDocuments
  const document = useMemo(() => {
    if (!isDocument) return null;

    return mockMentionDocuments.find((doc) => doc.id === documentId);
  }, [documentId, isDocument]);

  useEffect(() => {
    if (!document) return;
    if (
      element.coverImage !== document.coverImage ||
      element.icon !== document.icon ||
      element.value !== document.title
    ) {
      editor.tf.setNodes<MyMentionElement>(
        {
          coverImage: document.coverImage,
          icon: document.icon,
          value: document.title,
        },
        {
          at: [],
          mode: "lowest",
          match: (n) => n.type === MentionPlugin.key && n.id === element.id,
        }
      );
    }
  }, [
    document,
    editor.tf.setNodes,
    element.coverImage,
    element.icon,
    element.id,
    element.value,
  ]);

  const previewEditor = useEditorPreview(
    (document?.contentRich as Value | undefined)?.slice(0, 2) ?? []
  );

  return (
    <div className="flex flex-col overflow-hidden rounded">
      <div className={cn("h-10 w-full")}>
        {element.coverImage && (
          // biome-ignore lint/performance/noImgElement: This shared UI package cannot rely on next/image.
          <img
            alt={element.value}
            className="size-full object-cover"
            height={40}
            src={element.coverImage}
            width={100}
          />
        )}
      </div>
      <div className="absolute top-5 left-4 text-3xl">{element.icon}</div>
      <h1 className="mt-5 px-4 font-bold text-lg">{element.value}</h1>
      <EditorStatic
        className="px-4 text-xs"
        editor={previewEditor}
        // components={basicComponents}
        variant="mention"
      />
    </div>
  );
}

function UserMentionElement(
  props: PlateElementProps<MyMentionElement> & {
    prefix?: string;
  }
) {
  const { children } = props;
  const element = props.element;
  const readOnly = useReadOnly();
  const mounted = useMounted();
  const firstChild = (element.children?.[0] ?? {
    text: "",
  }) as MentionTextChild;

  return (
    <PlateElement
      {...props}
      attributes={{
        ...props.attributes,
        contentEditable: false,
        "data-slate-value": element.value,
        draggable: true,
      }}
      className={cn(
        "inline-block cursor-pointer align-baseline font-medium text-primary/65",
        !readOnly && "cursor-pointer",
        firstChild.bold === true && "font-bold",
        firstChild.italic === true && "italic",
        firstChild.underline === true && "underline"
      )}
    >
      <span className="font-semibold text-primary/45">@</span>
      {mounted && IS_APPLE ? (
        // Mac OS IME https://github.com/ianstormtaylor/slate/issues/3490
        <>
          {children}
          {props.prefix}
          {element.value}
        </>
      ) : (
        // Others like Android https://github.com/ianstormtaylor/slate/pull/5360
        <>
          {props.prefix}
          {element.value}
          {children}
        </>
      )}
    </PlateElement>
  );
}

export function MentionElement(
  props: PlateElementProps<MyMentionElement> & {
    prefix?: string;
  }
) {
  const element = props.element;
  const isDocument = element.key?.startsWith("/");

  return isDocument ? (
    <DocumentMentionElement {...props} />
  ) : (
    <UserMentionElement {...props} />
  );
}

type MentionTextChild = TText & {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
};

const useEditorPreview = (value: Value) => {
  const editorStatic = usePlateEditor(
    {
      plugins: BaseEditorKit,
      value,
    },
    [value]
  );

  return editorStatic;
};
