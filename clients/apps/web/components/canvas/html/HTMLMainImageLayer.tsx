'use client';

import { useLayerDepth } from '@/lib/editor/use-layer-depth';
import { useRef, useState, useCallback, useMemo, useEffect } from 'react';
import { type ShadowConfig } from '../utils/shadow-utils';
import { buildDropShadowFilter as buildSharedDropShadowFilter, parseShadowRgb } from '@/lib/drop-shadow';
import { type ImageBorder, type ImageFilters, useImageStore } from '@/lib/store';
import { ChromeFrame } from '@/components/frames/ChromeFrame';
import type { FrameChrome, Tone } from '@/lib/frames/schema';
import { CanvasObjectTopControls } from './CanvasObjectTopControls';
import { imageFilterCss } from '@/lib/editor/image-adjustments';
import { canvasOf, canvasScale, collectSnapLines, endSnapDrag, snapDrag } from '@/lib/editor/snap-dom';
import { removeScreenshot } from '@/lib/editor/remove-screenshot'

/** The main screenshot's browser or window chrome, with the tone it draws in. */
export type MainChromeFrame = { kind: 'browser' | 'window'; chrome: FrameChrome; tone: Tone };

export interface FrameConfig {
  enabled: boolean;
  type: ImageBorder['type'];
  width: number;
  color: string;
  padding?: number;
  title?: string;
  opacity?: number;
}

interface HTMLMainImageLayerProps {
  image: HTMLImageElement;
  canvasW: number;
  canvasH: number;
  framedW: number;
  framedH: number;
  frameOffset: number;
  windowPadding: number;
  windowHeader: number;
  imageScaledW: number;
  imageScaledH: number;
  screenshot: {
    offsetX: number;
    offsetY: number;
    rotation: number;
    radius: number;
    scale: number;
  };
  frame: FrameConfig;
  /** Browser or window chrome, drawn by the shared chrome renderer. */
  chrome?: MainChromeFrame | null;
  /** Chrome size multiplier (the header size setting). */
  chromeScale?: number;
  shadow: ShadowConfig;
  showFrame: boolean;
  imageOpacity: number;
  imageFilters?: ImageFilters;
  /** Where a scroll-through has the screenshot inside its frame. */
  imageObjectPosition?: string;
  isMainImageSelected: boolean;
  setIsMainImageSelected: (selected: boolean) => void;
  setSelectedOverlayId: (id: string | null) => void;
  setSelectedTextId: (id: string | null) => void;
  setScreenshot: (updates: Partial<HTMLMainImageLayerProps['screenshot']>) => void;
  onDragStateChange?: (isDragging: boolean) => void;
  onRemoveImage?: () => void;
}

function buildDropShadowFilter(shadow: ShadowConfig): string | undefined {
  if (!shadow.enabled) return undefined;
  return buildSharedDropShadowFilter({
    blur: shadow.softness,
    spread: shadow.spread || 0,
    color: shadow.color,
    opacity: shadow.intensity,
    offsetX: shadow.offsetX ?? 0,
    offsetY: shadow.offsetY ?? 0,
  });
}

/**
 * Builds a CSS box-shadow string for style frames.
 * Unlike drop-shadow, box-shadow follows border-radius and ignores content transparency,
 * so it wraps the entire frame+image uniformly.
 */
function buildBoxShadow(shadow: ShadowConfig): string | undefined {
  if (!shadow.enabled) return undefined;

  const { softness, spread, color, intensity, offsetX, offsetY } = shadow;
  const [r, g, b] = parseShadowRgb(color);

  const x = offsetX ?? 0;
  const y = offsetY ?? 0;
  const blur = softness + (spread || 0);
  const opacity = Math.min(1, Math.max(0, intensity));

  return [
    `${x}px ${y}px ${blur}px rgba(${r}, ${g}, ${b}, ${opacity})`,
    `0px 0px ${blur * 0.5}px rgba(${r}, ${g}, ${b}, ${opacity * 0.2})`,
  ].join(', ');
}

/**
 * HTML/CSS-based main image layer that replaces Konva MainImageLayer.
 * Renders the main image with frames, shadows, and filters.
 */
export function HTMLMainImageLayer({
  image,
  canvasW,
  canvasH,
  framedW,
  framedH,
  frameOffset: _frameOffset,
  windowPadding,
  windowHeader: _windowHeader,
  imageScaledW,
  imageScaledH,
  screenshot,
  frame,
  chrome,
  chromeScale = 1,
  shadow,
  showFrame,
  imageOpacity,
  imageFilters,
  imageObjectPosition,
  isMainImageSelected,
  setIsMainImageSelected,
  setSelectedOverlayId,
  setSelectedTextId,
  setScreenshot,
  onDragStateChange,
  onRemoveImage,
}: HTMLMainImageLayerProps) {
  const depth = useLayerDepth('__main__');
  const containerRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [isResizing, setIsResizing] = useState(false);
  const [isRotating, setIsRotating] = useState(false);
  const resizeStartRef = useRef<{ mouseX: number; mouseY: number; scale: number; handle: string } | null>(null);
  const rotateStartRef = useRef<{ centerX: number; centerY: number; startAngle: number; startRotation: number } | null>(null);

  const imageFilter = useMemo(() => imageFilterCss(imageFilters), [imageFilters]);
  const isStyleFrame = ['glass-light', 'glass-dark', 'outline-light', 'border-light', 'border-dark'].includes(frame.type);
  // Style frames use box-shadow on the frame container; others use drop-shadow filter on the outer div
  const shadowFilter = useMemo(() => isStyleFrame ? undefined : buildDropShadowFilter(shadow), [shadow, isStyleFrame]);
  const frameBoxShadow = useMemo(() => isStyleFrame ? buildBoxShadow(shadow) : undefined, [shadow, isStyleFrame]);

  const isArcFrame = frame.type === 'arc-light' || frame.type === 'arc-dark';
  const isPolaroid = frame.type === 'photograph';

  // Handle drag start
  const handleMouseDown = useCallback((e: React.PointerEvent) => {
    if (isResizing || isRotating) return;
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
    onDragStateChange?.(true);
    setDragStart({
      x: e.clientX - screenshot.offsetX * canvasScale(containerRef.current),
      y: e.clientY - screenshot.offsetY * canvasScale(containerRef.current),
    });
    setIsMainImageSelected(true);
    setSelectedOverlayId(null);
    setSelectedTextId(null);
  }, [isResizing, isRotating, screenshot.offsetX, screenshot.offsetY, setIsMainImageSelected, setSelectedOverlayId, setSelectedTextId, onDragStateChange]);

  // Handle resize start
  const handleResizeMouseDown = useCallback((e: React.PointerEvent, handle: string) => {
    e.preventDefault();
    e.stopPropagation();
    setIsResizing(true);
    resizeStartRef.current = {
      mouseX: e.clientX,
      mouseY: e.clientY,
      scale: useImageStore.getState().imageScale,
      handle,
    };
  }, []);

  // Drag, snapping the framed screenshot's edges and centre like every layer.
  useEffect(() => {
    if (!isDragging) return;
    const canvas = canvasOf(containerRef.current);
    const lines = canvas ? collectSnapLines(canvas, containerRef.current) : null;
    const previewScale = canvasScale(containerRef.current);
    const width = framedW * screenshot.scale * previewScale;
    const height = framedH * screenshot.scale * previewScale;

    let rafId: number | null = null;
    let latestEvent: PointerEvent | null = null;
    const applyMove = () => {
      rafId = null;
      const e = latestEvent;
      if (!e) return;
      const offsetX = e.clientX - dragStart.x;
      const offsetY = e.clientY - dragStart.y;
      const { dx, dy } = lines
        ? snapDrag(
            { height, width, x: canvasW * previewScale / 2 + offsetX - width / 2, y: canvasH * previewScale / 2 + offsetY - height / 2 },
            lines, previewScale
          )
        : { dx: 0, dy: 0 };
      setScreenshot({ offsetX: (offsetX + dx) / previewScale, offsetY: (offsetY + dy) / previewScale });
    };
    const handleMouseMove = (e: PointerEvent) => {
      latestEvent = e;
      if (rafId === null) rafId = requestAnimationFrame(applyMove);
    };

    const handleMouseUp = () => {
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        applyMove();
      }
      endSnapDrag();
      setIsDragging(false);
      onDragStateChange?.(false);
    };

    window.addEventListener('pointermove', handleMouseMove);
    window.addEventListener('pointerup', handleMouseUp);
    window.addEventListener('pointercancel', handleMouseUp);

    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      window.removeEventListener('pointermove', handleMouseMove);
      window.removeEventListener('pointerup', handleMouseUp);
      window.removeEventListener('pointercancel', handleMouseUp);
    };
  }, [isDragging, dragStart, setScreenshot, onDragStateChange, canvasW, canvasH, framedW, framedH, screenshot.scale]);

  // Handle resize move
  useEffect(() => {
    if (!isResizing) return;

    const scale = canvasScale(containerRef.current);
    let rafId: number | null = null;
    let latestEvent: PointerEvent | null = null;

    const applyResize = () => {
      rafId = null;
      const e = latestEvent;
      const start = resizeStartRef.current;
      if (!e || !start) return;

      // Calculate diagonal movement based on handle position
      const dx = (e.clientX - start.mouseX) / scale;
      const dy = (e.clientY - start.mouseY) / scale;

      // Determine direction multiplier based on handle corner
      let dirX = 1, dirY = 1;
      if (start.handle === 'tl') { dirX = -1; dirY = -1; }
      else if (start.handle === 'tr') { dirX = 1; dirY = -1; }
      else if (start.handle === 'bl') { dirX = -1; dirY = 1; }
      // 'br' is default (1, 1)

      // Project mouse movement onto diagonal direction
      const diagonal = (dx * dirX + dy * dirY) / 2;
      // Sensitivity: ~1 scale unit per 2px of movement
      const scaleDelta = diagonal * 0.5;
      const newScale = Math.round(Math.min(200, Math.max(10, start.scale + scaleDelta)));

      useImageStore.getState().setImageScale(newScale);
    };

    const handleMouseMove = (e: PointerEvent) => {
      latestEvent = e;
      if (rafId === null) rafId = requestAnimationFrame(applyResize);
    };

    const handleMouseUp = () => {
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        applyResize();
      }
      setIsResizing(false);
      resizeStartRef.current = null;
    };

    window.addEventListener('pointermove', handleMouseMove);
    window.addEventListener('pointerup', handleMouseUp);
    window.addEventListener('pointercancel', handleMouseUp);

    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      window.removeEventListener('pointermove', handleMouseMove);
      window.removeEventListener('pointerup', handleMouseUp);
      window.removeEventListener('pointercancel', handleMouseUp);
    };
  }, [isResizing]);

  // Handle rotate start
  const handleRotateMouseDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsRotating(true);

    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;

    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const startAngle = Math.atan2(e.clientY - centerY, e.clientX - centerX) * (180 / Math.PI);

    rotateStartRef.current = {
      centerX,
      centerY,
      startAngle,
      startRotation: screenshot.rotation,
    };
  }, [screenshot.rotation]);

  // Handle rotate move
  useEffect(() => {
    if (!isRotating) return;

    let rafId: number | null = null;
    let latestEvent: PointerEvent | null = null;

    const applyRotate = () => {
      rafId = null;
      const e = latestEvent;
      const start = rotateStartRef.current;
      if (!e || !start) return;

      const currentAngle = Math.atan2(e.clientY - start.centerY, e.clientX - start.centerX) * (180 / Math.PI);
      const delta = currentAngle - start.startAngle;
      const newRotation = Math.round(start.startRotation + delta);
      setScreenshot({ rotation: newRotation });
    };

    const handleMouseMove = (e: PointerEvent) => {
      latestEvent = e;
      if (rafId === null) rafId = requestAnimationFrame(applyRotate);
    };

    const handleMouseUp = () => {
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        applyRotate();
      }
      setIsRotating(false);
      rotateStartRef.current = null;
    };

    window.addEventListener('pointermove', handleMouseMove);
    window.addEventListener('pointerup', handleMouseUp);
    window.addEventListener('pointercancel', handleMouseUp);

    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      window.removeEventListener('pointermove', handleMouseMove);
      window.removeEventListener('pointerup', handleMouseUp);
      window.removeEventListener('pointercancel', handleMouseUp);
    };
  }, [isRotating, setScreenshot]);

  // Handle remove image
  const handleRemoveImage = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (onRemoveImage) {
      onRemoveImage();
    } else {
      removeScreenshot();
    }
  }, [onRemoveImage]);

  // Calculate position
  const centerX = canvasW / 2 + screenshot.offsetX;
  const centerY = canvasH / 2 + screenshot.offsetY;
  const left = centerX - framedW / 2;
  const top = centerY - framedH / 2;

  const handleScale = screenshot.scale > 0 ? 1 / screenshot.scale : 1;

  const browserRadius = screenshot.radius;

  // Arc frame styles
  const arcBorderWidth = frame.width || 8;
  const arcDefaultOpacity = frame.type === 'arc-light' ? 0.5 : 0.7;
  const arcOpacity = frame.opacity ?? arcDefaultOpacity;
  const arcBorderColor = frame.type === 'arc-light'
    ? `rgba(255, 255, 255, ${arcOpacity})`
    : `rgba(0, 0, 0, ${arcOpacity})`;

  // Get frame container styles based on frame type
  const getFrameContainerStyle = (): React.CSSProperties => {
    const baseStyle: React.CSSProperties = {
      position: 'relative',
      width: `${framedW}px`,
      height: `${framedH}px`,
      overflow: 'hidden',
    };

    if (isArcFrame) {
      return {
        ...baseStyle,
        border: `${arcBorderWidth}px solid ${arcBorderColor}`,
        borderRadius: `${screenshot.radius}px`,
      };
    }

    if (isPolaroid) {
      return {
        ...baseStyle,
        backgroundColor: 'white',
        borderRadius: '8px',
        padding: '8px 8px 24px 8px',
      };
    }

    if (isStyleFrame) {
      const styleConfig: Record<string, { bg: string }> = {
        'glass-light': { bg: `rgba(255, 255, 255, ${frame.opacity ?? 0.25})` },
        'glass-dark': { bg: `rgba(0, 0, 0, ${frame.opacity ?? 0.7})` },
        'outline-light': { bg: `rgba(255, 255, 255, ${frame.opacity ?? 0.35})` },
        'border-light': { bg: 'rgb(255, 255, 255)' },
        'border-dark': { bg: 'rgb(26, 26, 26)' },
      };
      const config = styleConfig[frame.type] || styleConfig['glass-light'];
      // Outer radius = inner radius + padding so curves are concentric (0 when no rounding)
      const outerRadius = screenshot.radius > 0 ? screenshot.radius + windowPadding : 0;
      return {
        ...baseStyle,
        backgroundColor: config.bg,
        borderRadius: `${outerRadius}px`,
        boxShadow: frameBoxShadow,
      };
    }

    // No frame
    return {
      ...baseStyle,
      borderRadius: `${screenshot.radius}px`,
    };
  };

  // Get image container styles
  const getImageContainerStyle = (): React.CSSProperties => {
    const baseStyle: React.CSSProperties = {
      position: 'absolute',
      width: `${imageScaledW}px`,
      height: `${imageScaledH}px`,
      overflow: 'hidden',
    };

    if (isArcFrame) {
      return {
        ...baseStyle,
        top: 0,
        left: 0,
        width: '100%',
        height: '100%',
        borderRadius: `${Math.max(0, screenshot.radius - arcBorderWidth)}px`,
      };
    }

    if (isPolaroid) {
      return {
        ...baseStyle,
        top: '8px',
        left: '8px',
        width: `calc(100% - 16px)`,
        height: `calc(100% - 32px)`,
        borderRadius: `${screenshot.radius}px`,
      };
    }

    if (isStyleFrame) {
      return {
        ...baseStyle,
        left: `${windowPadding}px`,
        top: `${windowPadding}px`,
        width: `${imageScaledW}px`,
        height: `${imageScaledH}px`,
        borderRadius: `${screenshot.radius}px`,
      };
    }

    // No frame
    return {
      ...baseStyle,
      top: 0,
      left: 0,
      width: '100%',
      height: '100%',
      borderRadius: `${screenshot.radius}px`,
    };
  };

  const mainImage = (
    <img
      src={image.src}
      crossOrigin={image.src.startsWith('blob:') || image.src.startsWith('data:') ? undefined : 'anonymous'}
      alt="Main image"
      draggable={false}
      style={{
        width: '100%',
        height: '100%',
        objectFit: 'cover',
        // A scroll-through moves the screenshot inside its frame.
        objectPosition: imageObjectPosition,
        opacity: imageOpacity,
        filter: imageFilter,
        display: 'block',
        borderRadius: 'inherit',
      }}
    />
  );

  return (
    <div
      ref={containerRef}
      data-main-image-layer="true"
      data-export-clean-outline={isMainImageSelected ? 'true' : undefined}
      onPointerDown={handleMouseDown}
      style={{
        position: 'absolute',
        left: `${left}px`,
        top: `${top}px`,
        width: `${framedW}px`,
        height: `${framedH}px`,
        transform: `rotate(${screenshot.rotation}deg) scale(${screenshot.scale})`,
        transformOrigin: 'center center',
        cursor: isResizing ? 'default' : isDragging ? 'grabbing' : 'grab',
        zIndex: depth,
        outline: isMainImageSelected ? '2px solid rgba(59, 130, 246, 0.5)' : 'none',
        outlineOffset: '2px',
        filter: shadowFilter,
      }}
    >
      {showFrame && chrome ? (
        // Browser and window chrome: the shared renderer places the image.
        <ChromeFrame frame={chrome} height={framedH} radius={browserRadius} scale={chromeScale} tone={chrome.tone} width={framedW}>
          {mainImage}
        </ChromeFrame>
      ) : (
        /* Frame container */
        <div style={getFrameContainerStyle()}>
          {/* Image container */}
          <div style={getImageContainerStyle()}>{mainImage}</div>
        </div>
      )}

      {/* Resize handles — visible when selected, excluded from export */}
      {isMainImageSelected && (
        <>
          {(['tl', 'tr', 'bl', 'br'] as const).map((handle) => {
            const isTop = handle[0] === 't';
            const isLeft = handle[1] === 'l';
            const cursor = (handle === 'tl' || handle === 'br') ? 'nwse-resize' : 'nesw-resize';
            return (
              <div
                key={handle}
                data-resize-handle="true"
                onPointerDown={(e) => handleResizeMouseDown(e, handle)}
                style={{
                  position: 'absolute',
                  width: '10px',
                  height: '10px',
                  backgroundColor: 'white',
                  border: '2px solid rgba(59, 130, 246, 0.8)',
                  borderRadius: '2px',
                  top: isTop ? '-5px' : undefined,
                  bottom: isTop ? undefined : '-5px',
                  left: isLeft ? '-5px' : undefined,
                  right: isLeft ? undefined : '-5px',
                  cursor,
                  zIndex: 20,
                  pointerEvents: 'auto',
                  transform: `scale(${handleScale})`,
                }}
              />
            );
          })}

          <CanvasObjectTopControls
            handleScale={handleScale}
            onRotatePointerDown={handleRotateMouseDown}
            onRemove={handleRemoveImage}
            objectLabel="image"
          />
        </>
      )}
    </div>
  );
}
