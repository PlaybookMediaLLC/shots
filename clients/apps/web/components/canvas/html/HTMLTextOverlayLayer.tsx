'use client';

import { useLayerDepth, reorderLayer } from '@/lib/editor/use-layer-depth';

import { useRef, useState, useCallback, useMemo, useEffect, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { shouldIgnoreEditorShortcut } from '@/lib/editor-shortcuts';
import { fitFontSize, textFillCss } from '@/lib/typography/text-style';
import { measureLine, useFontsVersion } from '@/lib/typography/measure';
import { getFontCSS } from '@/lib/constants/fonts';
import type { TextOverlay } from '@/lib/store';
import { canvasOf, canvasScale, collectSnapLines, endSnapDrag, snapDrag } from '@/lib/editor/snap-dom';
import type { SnapLines } from '@/lib/editor/snapping';
import { useLayerMotion, useTextReveal } from '@/lib/animation/use-motion';
import { RevealedText } from '../motion/motion-layers';
import { takeTextEdit } from "@/lib/editor/pending-text-edit";

export function getDraggedTextPosition(
  start: TextOverlay['position'], deltaX: number, deltaY: number, width: number, height: number,
): TextOverlay['position'] {
  if (width <= 0 || height <= 0) return start;
  return {
    x: Math.min(100, Math.max(0, start.x + deltaX / width * 100)),
    y: Math.min(100, Math.max(0, start.y + deltaY / height * 100)),
  };
}

interface HTMLTextOverlayLayerProps {
  textOverlays: TextOverlay[];
  canvasW: number;
  canvasH: number;
  selectedTextId: string | null;
  setSelectedTextId: (id: string | null) => void;
  setSelectedOverlayId: (id: string | null) => void;
  setIsMainImageSelected: (selected: boolean) => void;
  updateTextOverlay: (id: string, updates: Partial<TextOverlay>) => void;
}

interface DraggableTextProps {
  overlay: TextOverlay;
  canvasW: number;
  canvasH: number;
  isSelected: boolean;
  onSelect: () => void;
  onUpdate: (updates: Partial<TextOverlay>) => void;
}

function DraggableText({
  overlay,
  canvasW,
  canvasH,
  isSelected,
  onSelect,
  onUpdate,
}: DraggableTextProps) {
  const depth = useLayerDepth(overlay.id);
  const drag = useRef<{ x: number; y: number; position: TextOverlay["position"]; lines: SnapLines | null } | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isEditing, setIsEditing] = useState(() => takeTextEdit(overlay.id));
  const field = useRef<HTMLDivElement>(null);
  // The field is uncontrolled while typing; its words are committed as it closes.
  useEffect(() => {
    const element = field.current;
    if (!isEditing || !element) return;
    element.textContent = overlay.text;
    element.focus();
    const selection = window.getSelection();
    selection?.selectAllChildren(element);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEditing]);
  const finishEditing = () => {
    const text = field.current?.innerText.replace(/\n$/, "") ?? overlay.text;
    setIsEditing(false);
    if (text !== overlay.text) onUpdate({ text });
  };

  // Convert percentage position to pixels
  const textX = (overlay.position.x / 100) * canvasW;
  const textY = (overlay.position.y / 100) * canvasH;

  // Build text shadow CSS. A gradient fill makes the glyphs transparent, so
  // its shadow is a drop-shadow of the painted text instead of text-shadow.
  const shadow = overlay.textShadow?.enabled
    ? `${overlay.textShadow.offsetX}px ${overlay.textShadow.offsetY}px ${overlay.textShadow.blur}px ${overlay.textShadow.color}`
    : undefined;
  const gradient = overlay.fill?.kind === 'gradient';
  const fontVersion = useFontsVersion();
  const fontCss = getFontCSS(overlay.fontFamily);
  const boxWidth = overlay.maxWidth ? overlay.maxWidth * canvasW : undefined;
  // Shrink-to-fit is measured with the browser's own text metrics, again once fonts load.
  const fontSize = useMemo(
    () =>
      overlay.fit === 'shrink' && boxWidth
        ? fitFontSize(overlay.text.split('\n'), overlay.fontSize, boxWidth, (line) =>
            measureLine(line, { family: fontCss, letterSpacing: overlay.letterSpacing, size: overlay.fontSize, weight: overlay.fontWeight })
          )
        : overlay.fontSize,
    // fontVersion re-measures after a web font finishes loading.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [boxWidth, fontCss, fontVersion, overlay.fit, overlay.fontSize, overlay.fontWeight, overlay.letterSpacing, overlay.text]
  );

  // Keyframes and a reveal are drawn at the playhead; dragging edits the design.
  const motionTarget = useMemo(() => ({ id: overlay.id, kind: 'text' as const }), [overlay.id]);
  const motion = useLayerMotion(motionTarget);
  const reveal = useTextReveal(overlay.id, overlay.text);

  if (!overlay.isVisible) return null;

  return (
    <div
      data-text-overlay-id={overlay.id}
      data-export-clean-outline={isSelected ? 'true' : undefined}
      ref={field}
      {...(isEditing
        ? {
            'aria-label': 'Edit text',
            'aria-multiline': true,
            contentEditable: 'plaintext-only' as const,
            role: 'textbox',
            suppressContentEditableWarning: true,
            onBlur: finishEditing,
            onKeyDown: (event: ReactKeyboardEvent) => {
              event.stopPropagation();
              if (event.key === 'Escape' || (event.key === 'Enter' && (event.metaKey || event.ctrlKey))) {
                event.preventDefault();
                field.current?.blur();
              }
            },
          }
        : {})}
      onDoubleClick={() => setIsEditing(true)}
      onPointerDown={(event) => {
        if (isEditing) {
          event.stopPropagation();
          return;
        }
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.setPointerCapture(event.pointerId);
        const canvas = canvasOf(event.currentTarget);
        drag.current = {
          x: event.clientX,
          y: event.clientY,
          position: overlay.position,
          lines: canvas ? collectSnapLines(canvas, event.currentTarget) : null,
        };
        setIsDragging(true);
        onSelect();
      }}
      onPointerMove={(event) => {
        if (!drag.current) return;
        const bounds = event.currentTarget.parentElement!.getBoundingClientRect();
        const own = event.currentTarget.getBoundingClientRect();
        let deltaX = event.clientX - drag.current.x;
        let deltaY = event.clientY - drag.current.y;
        if (drag.current.lines) {
          const centerX = (drag.current.position.x / 100) * bounds.width + deltaX;
          const centerY = (drag.current.position.y / 100) * bounds.height + deltaY;
          const snap = snapDrag(
            { height: own.height, width: own.width, x: centerX - own.width / 2, y: centerY - own.height / 2 },
            drag.current.lines, canvasScale(event.currentTarget)
          );
          deltaX += snap.dx;
          deltaY += snap.dy;
        }
        onUpdate({ position: getDraggedTextPosition(drag.current.position, deltaX, deltaY, bounds.width, bounds.height) });
      }}
      onPointerUp={() => { drag.current = null; setIsDragging(false); endSnapDrag(); }}
      onPointerCancel={() => { drag.current = null; setIsDragging(false); endSnapDrag(); }}
      onLostPointerCapture={() => { drag.current = null; setIsDragging(false); endSnapDrag(); }}
      style={{
        position: 'absolute',
        left: `${textX + motion.x * canvasW}px`,
        top: `${textY + motion.y * canvasH}px`,
        transform: `translate(-50%, -50%) rotate(${motion.rotation}deg) scale(${motion.scale})`,
        fontSize: `${fontSize}px`,
        fontWeight: overlay.fontWeight.includes('bold') ? 'bold' : overlay.fontWeight === 'italic' ? 'normal' : overlay.fontWeight,
        fontStyle: overlay.fontWeight.includes('italic') ? 'italic' : 'normal',
        fontFamily: fontCss,
        ...textFillCss(overlay.fill, overlay.color),
        opacity: overlay.opacity * motion.opacity,
        textShadow: gradient ? undefined : shadow,
        filter: gradient && shadow ? `drop-shadow(${shadow})` : undefined,
        whiteSpace: overlay.fit === 'wrap' && boxWidth ? 'pre-wrap' : 'pre',
        width: overlay.fit === 'wrap' ? boxWidth : undefined,
        textAlign: overlay.align ?? 'center',
        letterSpacing: overlay.letterSpacing ? `${overlay.letterSpacing}em` : undefined,
        lineHeight: overlay.lineHeight ?? 1.2,
        touchAction: 'none',
        cursor: isEditing ? 'text' : isDragging ? 'grabbing' : 'grab',
        userSelect: isEditing ? 'text' : 'none',
        writingMode: overlay.orientation === 'vertical' ? 'vertical-rl' : 'horizontal-tb',
        outline: isSelected ? '2px solid rgba(59, 130, 246, 0.5)' : 'none',
        outlineOffset: '4px',
        zIndex: depth,
        pointerEvents: 'auto',
      }}
    >
      {isEditing ? null : reveal ? <RevealedText {...reveal} /> : overlay.text}
    </div>
  );
}

/**
 * HTML/CSS-based text overlay layer that replaces Konva TextOverlayLayer.
 * Renders text overlays with drag support.
 */
export function HTMLTextOverlayLayer({
  textOverlays,
  canvasW,
  canvasH,
  selectedTextId,
  setSelectedTextId,
  setSelectedOverlayId,
  setIsMainImageSelected,
  updateTextOverlay,
}: HTMLTextOverlayLayerProps) {
  useEffect(() => {
    if (!selectedTextId) return;
    const reorder = (event: KeyboardEvent) => {
      if (!event.altKey || shouldIgnoreEditorShortcut(event) || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
      const text = textOverlays.find((item) => item.id === selectedTextId);
      if (!text) return;
      event.preventDefault();
      reorderLayer(text.id, event.key === 'ArrowUp' ? 'up' : 'down');
    };
    window.addEventListener('keydown', reorder);
    return () => window.removeEventListener('keydown', reorder);
  }, [selectedTextId, textOverlays, updateTextOverlay]);

  const handleSelect = useCallback((id: string) => {
    setSelectedTextId(id);
    setSelectedOverlayId(null);
    setIsMainImageSelected(false);
  }, [setSelectedTextId, setSelectedOverlayId, setIsMainImageSelected]);

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        width: `${canvasW}px`,
        height: `${canvasH}px`,
        pointerEvents: 'none',
      }}
    >
      {textOverlays.map((overlay) => (
        <DraggableText
          key={overlay.id}
          overlay={overlay}
          canvasW={canvasW}
          canvasH={canvasH}
          isSelected={selectedTextId === overlay.id}
          onSelect={() => handleSelect(overlay.id)}
          onUpdate={(updates) => updateTextOverlay(overlay.id, updates)}
        />
      ))}
    </div>
  );
}
