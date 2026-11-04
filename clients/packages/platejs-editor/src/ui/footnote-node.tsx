"use client";

import type { TFootnoteElement } from "@platejs/footnote";
import { FootnoteReferencePlugin } from "@platejs/footnote/react";
import type { PlateElementProps } from "platejs/react";
import {
  PlateElement,
  useEditorSelector,
  useFocused,
  useNavigationHighlight,
  usePath,
  useSelected,
} from "platejs/react";
import type { CSSProperties } from "react";
import { useCallback, useState } from "react";

import { cn } from "../lib/utils";
import { Button } from "./button";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "./hover-card";
import {
  InlineCombobox,
  InlineComboboxContent,
  InlineComboboxEmpty,
  InlineComboboxGroup,
  InlineComboboxInput,
  InlineComboboxItem,
} from "./inline-combobox";

const NUMERIC_FOOTNOTE_QUERY = /^\d+$/;

const getNavigationAttributes = (
  attributes: PlateElementProps<TFootnoteElement>["attributes"],
  navigationHighlight: ReturnType<typeof useNavigationHighlight>
) => ({
  ...attributes,
  "data-nav-cycle": navigationHighlight
    ? String(navigationHighlight.cycle)
    : undefined,
  "data-nav-primary": navigationHighlight?.variant,
  "data-nav-pulse": navigationHighlight
    ? String(navigationHighlight.pulse)
    : undefined,
  "data-nav-target": navigationHighlight ? "true" : undefined,
  style: {
    ...(attributes.style as CSSProperties | undefined),
    "--plate-nav-feedback-duration": navigationHighlight
      ? `${navigationHighlight.duration}ms`
      : undefined,
  } as CSSProperties,
});

export function FootnoteReferenceElement(
  props: PlateElementProps<TFootnoteElement>
) {
  const { editor, element } = props;
  const identifier = element.identifier ?? "";
  const footnoteApi = editor.getApi(FootnoteReferencePlugin).footnote;
  const footnoteTransforms = editor.getTransforms(
    FootnoteReferencePlugin
  ).footnote;
  const path = usePath();
  const navigationHighlight = useNavigationHighlight(path);
  const selected = useSelected();
  const focused = useFocused();
  const [hoverOpen, setHoverOpen] = useState(false);
  const preview = useEditorSelector(
    () => ({
      isResolved: identifier
        ? footnoteApi.isResolved({ identifier })
        : false,
      text: identifier
        ? footnoteApi.definitionText({ identifier })
        : undefined,
    }),
    [identifier, hoverOpen]
  );

  const openDefinition = () => {
    if (preview.isResolved) {
      footnoteTransforms.focusDefinition({ identifier });
      return;
    }

    footnoteTransforms.createDefinition({ identifier });
  };

  return (
    <PlateElement
      {...props}
      as="sup"
      attributes={{
        ...getNavigationAttributes(props.attributes, navigationHighlight),
        contentEditable: false,
        draggable: true,
      }}
      className="group/footnote-ref mx-0.5 align-super"
    >
      {props.children}
      <HoverCard onOpenChange={setHoverOpen} open={hoverOpen} openDelay={150}>
        <HoverCardTrigger asChild>
          <button
            className={cn(
              "cursor-pointer rounded-md font-medium text-primary text-xs group-data-[nav-target=true]/footnote-ref:bg-primary/30",
              selected && focused && "ring-2 ring-ring"
            )}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              openDefinition();
            }}
            type="button"
          >
            [{identifier}]
          </button>
        </HoverCardTrigger>
        <HoverCardContent className="w-80">
          {preview.text ? (
            <p className="text-muted-foreground text-sm leading-relaxed">
              {preview.text}
            </p>
          ) : (
            <Button onClick={openDefinition} size="xs" variant="outline">
              Create definition for [^{identifier}]
            </Button>
          )}
        </HoverCardContent>
      </HoverCard>
    </PlateElement>
  );
}

export function FootnoteDefinitionElement(
  props: PlateElementProps<TFootnoteElement>
) {
  const { editor, element } = props;
  const identifier = element.identifier ?? "";
  const footnoteApi = editor.getApi(FootnoteReferencePlugin).footnote;
  const footnoteTransforms = editor.getTransforms(
    FootnoteReferencePlugin
  ).footnote;
  const path = usePath();
  const navigationHighlight = useNavigationHighlight(path);
  const isDuplicate = useEditorSelector(
    () => (path ? footnoteApi.isDuplicateDefinition({ path }) : false),
    [identifier, path]
  );
  const nextIdentifier = useEditorSelector(
    () => (isDuplicate ? footnoteApi.nextId() : undefined),
    [isDuplicate]
  );

  return (
    <PlateElement
      {...props}
      attributes={getNavigationAttributes(
        props.attributes,
        navigationHighlight
      )}
      className={cn(
        "mt-1.5 flex items-start gap-2 data-[nav-target=true]:bg-primary/30",
        isDuplicate && "border border-amber-500/30 bg-amber-500/5 p-2"
      )}
    >
      <button
        aria-label={`Back to footnote reference ${identifier}`}
        className="min-w-4 text-muted-foreground text-xs tabular-nums hover:text-foreground"
        contentEditable={false}
        onClick={(event) => {
          event.preventDefault();
          footnoteTransforms.focusReference({ identifier });
        }}
        type="button"
      >
        {identifier}
      </button>
      <div className="min-w-0 flex-1">
        {isDuplicate && nextIdentifier && path ? (
          <Button
            className="mb-2"
            contentEditable={false}
            onClick={() => {
              footnoteTransforms.normalizeDuplicateDefinition({
                identifier: nextIdentifier,
                path,
              });
            }}
            size="xs"
            variant="outline"
          >
            Renumber to [^{nextIdentifier}]
          </Button>
        ) : null}
        {props.children}
      </div>
    </PlateElement>
  );
}

export function FootnoteInputElement(props: PlateElementProps) {
  const { editor, element } = props;
  const [search, setSearch] = useState("");
  const footnoteApi = editor.getApi(FootnoteReferencePlugin).footnote;
  const insertFootnote = editor.getTransforms(FootnoteReferencePlugin).insert;
  const identifiers = footnoteApi.identifiers();
  const query = search.trim();
  const requestedIdentifier = NUMERIC_FOOTNOTE_QUERY.test(query) ? query : "";
  const proposedIdentifier = requestedIdentifier || footnoteApi.nextId();
  const filteredIdentifiers = identifiers.filter((identifier) => {
    if (!query) {
      return true;
    }

    const preview = footnoteApi.definitionText({ identifier }) ?? "";
    return (
      identifier.includes(query) ||
      preview.toLowerCase().includes(query.toLowerCase())
    );
  });

  const selectFootnote = useCallback(
    (identifier: string) => {
      const before = editor.selection && editor.api.before(editor.selection);

      if (before) {
        const range = editor.api.range(before, editor.selection);
        if (range && editor.api.string(range) === "[") {
          editor.tf.deleteBackward("character");
        }
      }

      insertFootnote.footnote({ focusDefinition: false, identifier });
    },
    [editor, insertFootnote]
  );

  const canCreate = !identifiers.includes(proposedIdentifier);

  return (
    <PlateElement {...props} as="span" className="rounded-sm bg-accent px-0.5 text-accent-foreground">
      <InlineCombobox
        element={element}
        filter={false}
        setValue={setSearch}
        trigger="^"
        value={search}
      >
        <InlineComboboxInput className="min-w-[1ch]" />
        <InlineComboboxContent className="my-1.5 w-72">
          {canCreate || filteredIdentifiers.length > 0 ? null : (
            <InlineComboboxEmpty>No footnotes</InlineComboboxEmpty>
          )}
          <InlineComboboxGroup>
            {canCreate && (!query || requestedIdentifier) ? (
              <InlineComboboxItem
                onClick={() => selectFootnote(proposedIdentifier)}
                value={`new-${proposedIdentifier}`}
              >
                New footnote [^{proposedIdentifier}]
              </InlineComboboxItem>
            ) : null}
            {filteredIdentifiers.map((identifier) => (
              <InlineComboboxItem
                key={identifier}
                onClick={() => selectFootnote(identifier)}
                value={`footnote-${identifier}`}
              >
                [^{identifier}]: {footnoteApi.definitionText({ identifier })}
              </InlineComboboxItem>
            ))}
          </InlineComboboxGroup>
        </InlineComboboxContent>
      </InlineCombobox>
      {props.children}
    </PlateElement>
  );
}
