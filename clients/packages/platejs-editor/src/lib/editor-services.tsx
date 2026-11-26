"use client";

import { createContext, type ReactNode, useContext } from "react";

/**
 * Services the host app injects into the editor. The package never reaches a
 * network route, an environment variable or a storage provider by itself:
 * uploads and AI requests go through whatever the app passes here, and an
 * editor without a service simply does not offer that feature.
 */

/** A file the host stored. `url` must render in an `<img>` or `<video>`. */
export interface EditorUploadedFile {
  /** The host's id for the stored file, kept on the media node. */
  assetId?: string;
  name: string;
  size: number;
  type: string;
  url: string;
}

export interface EditorUploadOptions {
  /** Upload progress from 0 to 100. */
  onProgress?: (percent: number) => void;
  signal?: AbortSignal;
}

/** Stores one file and resolves once it can be referenced from a document. */
export type EditorUploadFile = (
  file: File,
  options?: EditorUploadOptions
) => Promise<EditorUploadedFile>;

/** One AI endpoint. `fetch` lets the host add headers or route the call. */
export interface EditorAIEndpoint {
  api: string;
  fetch?: typeof globalThis.fetch;
}

/** One AI action the host adds to the AI menu, beside the editor's own. */
export interface EditorAIAction {
  /** The menu heading the action sits under. */
  group: string;
  label: string;
  onSelect: () => void;
}

export interface EditorAIServices {
  /** Host actions listed in the AI menu before a request is sent. */
  actions?: readonly EditorAIAction[];
  /** Streams AI SDK UI messages for the AI menu (generate, edit, comment). */
  chat?: EditorAIEndpoint;
  /** Answers `{ prompt }` with `{ text }` for inline ghost-text completion. */
  copilot?: EditorAIEndpoint;
}

export interface EditorServices {
  ai?: EditorAIServices;
  uploadFile?: EditorUploadFile;
}

const EditorServicesContext = createContext<EditorServices>({});

export function EditorServicesProvider({
  children,
  services,
}: {
  children: ReactNode;
  services: EditorServices;
}) {
  return (
    <EditorServicesContext.Provider value={services}>
      {children}
    </EditorServicesContext.Provider>
  );
}

export const useEditorServices = (): EditorServices =>
  useContext(EditorServicesContext);
