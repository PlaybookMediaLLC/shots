'use client';

import * as React from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { toast } from 'sonner';
import { locales } from '@/i18n/routing';
import { transferImageFiles } from '@/lib/editor/transfer-image-files';
import { isLocalDropTarget } from '@/lib/drop-routing';
import { shouldIgnoreEditorShortcut } from '@/lib/editor-shortcuts';

interface GlobalDropZoneProps {
  children: React.ReactNode;
}

export function GlobalDropZone({ children }: GlobalDropZoneProps) {
  const [isDraggingOver, setIsDraggingOver] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const dragCounterRef = React.useRef(0);
  const router = useRouter();
  const pathname = usePathname();

  const locale = locales.find((locale) => pathname === `/${locale}` || pathname.startsWith(`/${locale}/`));
  // The fork serves the signed-in editor at the locale root, not /editor.
  const editorPath = locale ? `/${locale}/editor` : '/editor';
  const isEditorPage = pathname === editorPath;

  // Import validation finishes before the command chooses a target and writes it.
  const handleFiles = React.useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;
      try {
        const { importImages } = await import('@/lib/editor/import-images');
        const result = await importImages(files);
        const firstRejection = result.rejected[0];
        if (firstRejection) {
          setError(firstRejection.reason);
          toast.error(firstRejection.reason);
          setTimeout(() => setError(null), 3000);
        }
        if (result.imported > 0) {
          setError(null);
          setIsDraggingOver(false);
          if (!isEditorPage) router.push(editorPath);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'The image could not be imported.';
        setError(message);
        toast.error(message);
      }
    },
    [isEditorPage, editorPath, router]
  );

  // Global drag events
  React.useEffect(() => {
    const handleDragEnter = (e: DragEvent) => {
      if (isLocalDropTarget(e.target)) {
        dragCounterRef.current = 0;
        setIsDraggingOver(false);
        return;
      }
      e.preventDefault();
      dragCounterRef.current++;
      if (e.dataTransfer?.types.includes('Files')) {
        setIsDraggingOver(true);
        setError(null);
      }
    };

    const handleDragOver = (e: DragEvent) => {
      if (isLocalDropTarget(e.target)) return;
      e.preventDefault();
      if (e.dataTransfer) {
        e.dataTransfer.dropEffect = 'copy';
      }
    };

    const handleDragLeave = (e: DragEvent) => {
      if (isLocalDropTarget(e.target)) return;
      e.preventDefault();
      dragCounterRef.current--;
      if (dragCounterRef.current <= 0) {
        dragCounterRef.current = 0;
        setIsDraggingOver(false);
      }
    };

    const handleDrop = (e: DragEvent) => {
      if (isLocalDropTarget(e.target)) {
        dragCounterRef.current = 0;
        setIsDraggingOver(false);
        return;
      }
      e.preventDefault();
      dragCounterRef.current = 0;
      setIsDraggingOver(false);

      handleFiles(transferImageFiles(e.dataTransfer));
    };

    document.addEventListener('dragenter', handleDragEnter);
    document.addEventListener('dragover', handleDragOver);
    document.addEventListener('dragleave', handleDragLeave);
    document.addEventListener('drop', handleDrop);

    return () => {
      document.removeEventListener('dragenter', handleDragEnter);
      document.removeEventListener('dragover', handleDragOver);
      document.removeEventListener('dragleave', handleDragLeave);
      document.removeEventListener('drop', handleDrop);
    };
  }, [handleFiles]);

  // Handle image pastes before and after the editor's upload state unmounts.
  React.useEffect(() => {
    const handlePaste = (e: ClipboardEvent) => {
      if (shouldIgnoreEditorShortcut(e)) return;
      const files = transferImageFiles(e.clipboardData);
      if (files.length === 0) return;
      e.preventDefault();
      handleFiles(files);
    };

    // Let local paste handlers (for example device screens) consume it first.
    window.addEventListener('paste', handlePaste);
    return () => window.removeEventListener('paste', handlePaste);
  }, [handleFiles]);

  return (
    <>
      {children}

      {isDraggingOver && (
        <div
          className="pointer-events-none fixed inset-0 z-[9999] flex items-center justify-center animate-in fade-in duration-200"
          style={{ backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)' }}
        >
          {/* Dark overlay */}
          <div className="absolute inset-0 bg-background/80" />

          {/* Drop zone content */}
          <div className="relative z-10 flex flex-col items-center gap-6 animate-in zoom-in-95 fade-in duration-200">
            {/* Dashed border box */}
            <div
              className="flex h-[280px] w-[420px] flex-col items-center justify-center gap-4 rounded-2xl border-[2.5px] border-dashed border-primary/70 transition-colors"
              style={{ background: 'hsl(var(--muted) / 0.5)' }}
            >
              {/* Animated arrow icon */}
              <svg
                width="48"
                height="48"
                viewBox="0 0 48 48"
                fill="none"
                className="animate-bounce text-primary"
              >
                <path
                  d="M24 6v28M14 24l10 10 10-10"
                  stroke="currentColor"
                  strokeWidth="3"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <line
                  x1="10"
                  y1="42"
                  x2="38"
                  y2="42"
                  stroke="currentColor"
                  strokeWidth="3"
                  strokeLinecap="round"
                />
              </svg>

              <div className="text-center">
                <p className="text-lg font-semibold text-foreground">
                  Drop your image here
                </p>
                <p className="mt-1 text-sm text-muted-foreground">
                  PNG, JPG, or WEBP
                </p>
              </div>
            </div>

            {/* Error message */}
            {error && (
              <div className="animate-in fade-in slide-in-from-bottom-2 rounded-lg border border-destructive/20 bg-destructive/10 px-4 py-2 text-sm text-destructive duration-150">
                {error}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
