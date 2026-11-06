'use client';

import * as React from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { motion, AnimatePresence } from 'motion/react';
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

      <AnimatePresence>
        {isDraggingOver && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="pointer-events-none fixed inset-0 z-[9999] flex items-center justify-center"
            style={{ backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)' }}
          >
            {/* Dark overlay */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute inset-0 bg-background/80"
            />

            {/* Drop zone content */}
            <motion.div
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              transition={{ type: 'spring', damping: 25, stiffness: 300 }}
              className="relative z-10 flex flex-col items-center gap-6"
            >
              {/* Animated dashed border box */}
              <motion.div
                className="w-[420px] h-[280px] rounded-2xl flex flex-col items-center justify-center gap-4"
                style={{
                  border: '2.5px dashed',
                  borderColor: 'var(--border)',
                  background: 'hsl(var(--muted) / 0.5)',
                }}
                animate={{
                  borderColor: ['hsl(var(--border))', 'hsl(var(--primary))', 'hsl(var(--border))'],
                }}
                transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}
              >
                {/* Animated arrow icon */}
                <motion.svg
                  width="48"
                  height="48"
                  viewBox="0 0 48 48"
                  fill="none"
                  className="text-primary"
                  animate={{ y: [0, -6, 0] }}
                  transition={{ duration: 1.5, repeat: Infinity, ease: 'easeInOut' }}
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
                </motion.svg>

                <div className="text-center">
                  <p className="text-lg font-semibold text-foreground">
                    Drop your image here
                  </p>
                  <p className="text-sm text-muted-foreground mt-1">
                    PNG, JPG, or WEBP
                  </p>
                </div>
              </motion.div>

              {/* Error message */}
              <AnimatePresence>
                {error && (
                  <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: 10 }}
                    className="px-4 py-2 rounded-lg bg-destructive/10 border border-destructive/20 text-sm text-destructive"
                  >
                    {error}
                  </motion.div>
                )}
              </AnimatePresence>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
