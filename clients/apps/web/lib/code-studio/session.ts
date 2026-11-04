'use client'

import type { TRPCClient } from '@trpc/client'
import type { AppRouter } from '@/lib/trpc/router'
import { trackEvent } from '@/lib/analytics'
import { mergeConcurrent } from '@/lib/creative-sets/concurrent'
import { newCreativeSetId } from '@/lib/creative-sets/document'
import {
  readRecoveries,
  removeSetRecovery,
  writeRecovery,
  type DocumentRecovery,
  type RecoveryKind,
} from '@/lib/creative-sets/recovery'
import {
  RevisionedSession,
  type RevisionedRecord,
  type RevisionedSessionState,
  type RevisionedStorage,
} from '@/lib/creative-sets/revisioned-session'
import { codeDocumentSchema, type CodeDocument } from './document'

/** A stored code project. */
export type CodeProjectRecord = RevisionedRecord<CodeDocument>
/** What the studio renders from. */
export type CodeSessionState = RevisionedSessionState<CodeDocument>

/** Field-level merge: slides, panes and files carry stable ids, so independent edits combine. */
export function mergeCodeConcurrent(
  base: CodeDocument,
  local: CodeDocument,
  remote: CodeDocument
): CodeDocument {
  return codeDocumentSchema.parse(mergeConcurrent(base, local, remote, 'code'))
}

// A code project holds no local images, so its drafts have no native documents.
const codeRecovery: RecoveryKind<CodeDocument> = {
  parse: (raw) => codeDocumentSchema.parse(raw),
  natives: () => [],
  mapNatives: (document) => document,
}

/** This device's drafts of one code project, newest first. */
export function readCodeRecoveries(workspaceId: string, projectId: string) {
  return readRecoveries(workspaceId, projectId, codeRecovery)
}

const storage: RevisionedStorage<CodeDocument> = {
  write: (record: DocumentRecovery<CodeDocument>) => writeRecovery(record, codeRecovery),
  remove: removeSetRecovery,
}

/**
 * The open code project: undo, autosave, local recovery and conflict
 * handling, through the same revision-checked path as canvases.
 */
export class CodeSession extends RevisionedSession<CodeDocument> {
  private copyId = newCreativeSetId()
  constructor(record: CodeProjectRecord, client: TRPCClient<AppRouter>) {
    super(record, client, storage, {
      label: 'code_project',
      parse: (document) => codeDocumentSchema.parse(document),
      merge: mergeCodeConcurrent,
      upload: async (document) => document,
      resolveUploads: (current) => current,
      get: () => client.codeProject.get.query({ projectId: record.id }),
      update: (baseRevision, document) =>
        client.codeProject.updateDocument.mutate({ projectId: record.id, baseRevision, document }),
    })
    trackEvent('code_project_open', { slides: record.document.slides.length })
  }
  /** Save this tab's work as a new project after a conflict, leaving the saved one untouched. */
  preserveCopy() {
    return this.client.codeProject.create.mutate({
      id: this.copyId,
      document: this.history.document,
      name: `${this.record.name.slice(0, 180)} recovered copy`,
    })
  }
}
