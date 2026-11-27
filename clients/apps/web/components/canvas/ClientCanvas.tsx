"use client";

import { useLayerDepth, reorderLayer } from '@/lib/editor/use-layer-depth';
import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { selectScreenshot, useImageStore } from "@/lib/store";
import { generatePattern } from "@/lib/patterns";
import { useResponsiveCanvasDimensions } from "@/hooks/useAspectRatioDimensions";
import { generateNoiseTexture } from "@/lib/export/export-utils";
import { MockupSceneRenderer } from "@/components/mockups/MockupRenderer";
import { useDeviceUIStore } from "@/lib/store/device-ui";
import { shouldIgnoreEditorShortcut } from "@/lib/editor-shortcuts";
import { calculateCanvasDimensions, mainImageRect } from "./utils/canvas-dimensions";
import { CanvasGeometryContext, type CanvasGeometry } from "./elements/canvas-geometry";
import { useCompositeSource } from './elements/use-composite-source'
import { ElementLayer } from "./elements/ElementLayer";
import { imageFilterCss } from "@/lib/editor/image-adjustments";
import { toCanvasShadow } from "./utils/shadow-utils";
import { useImageMotion } from "@/lib/animation/use-image-motion";
import { MAIN_IMAGE_TARGET, useLayerMotion, useScroll } from "@/lib/animation/use-motion";
import { coverOverflow, imageWithMotion, scrollObjectPosition } from "@/lib/animation/motion-evaluate";
import { CaptionLayer } from "./motion/motion-layers";
import { useTextFontLoader } from "@/lib/typography/load-text-fonts";
import { CanvasStageShell } from "./CanvasStageShell";
import { Perspective3DOverlay } from "./overlays/Perspective3DOverlay";
import { useOverlayImages } from "./hooks/useImageLoading";
import {
  HTMLCanvasRenderer,
  HTMLBackgroundLayer,
  HTMLPatternLayer,
  HTMLMainImageLayer,
  HTMLTextOverlayLayer,
  HTMLImageOverlayLayer,
  SVGAnnotationLayer,
  HTMLBlurRegionLayer,
  SnapAlignmentGuides,
  HTMLGridLayer,
} from "./html";
import { CanvasRulers } from "./CanvasRulers";
import { CanvasGuidesLayer } from "./html/CanvasGuidesLayer";
import {
  hasVisibleMockups,
  shouldRenderSourceImage,
} from "@/lib/device-mockups/layouts";
import { removeScreenshot } from '@/lib/editor/remove-screenshot'
import { useMainChromeFrame } from "@/components/frames/use-main-chrome";
import { useFrameToneSync } from "@/lib/frames/use-frame-tone";
import { hasCanvasContent } from "@/lib/editor/canvas-content";

// Reference to the HTML canvas container for export
let globalCanvasContainer: HTMLDivElement | null = null;

function CanvasRenderer({ image }: { image: HTMLImageElement }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasContainerRef = useRef<HTMLDivElement>(null);
  const screenshot = useImageStore(useShallow(selectScreenshot));
  const setImagePlacement = useImageStore((state) => state.setImagePlacement);
  const patternStyle = useImageStore((state) => state.pattern);
  const canvasPadding = useImageStore((state) => state.canvasPadding);
  const imageShadow = useImageStore((state) => state.imageShadow);
  const shadow = useMemo(() => toCanvasShadow(imageShadow), [imageShadow]);
  useTextFontLoader();
  // Drawn values at the playhead; the document keeps its own.
  const presetMotion = useImageMotion();
  const imageLayerMotion = useLayerMotion(MAIN_IMAGE_TARGET);
  // A scroll-through shows the screenshot through a viewport of its own shape.
  const imageScroll = useScroll(MAIN_IMAGE_TARGET);
  const scrollViewport = imageScroll?.scroll.viewport;
  const layoutImage = useMemo(
    () => (scrollViewport ? { naturalHeight: 1000, naturalWidth: Math.round(scrollViewport * 1000) } : image),
    [image, scrollViewport]
  );

  const {
    backgroundConfig,
    uploadedImageUrl,
    backgroundBorderRadius,
    backgroundBlur,
    backgroundNoise,
    imageFilters,
    textOverlays,
    imageOverlays,
    mockups,
    editorMode,
    imageBorder,
    updateTextOverlay,
    updateImageOverlay,
    removeImageOverlay,
    addImageOverlay,
    removeMockup,
    // Annotations
    annotations,
    activeAnnotationTool,
    selectedAnnotationId,
    setSelectedAnnotationId,
    annotationDefaults,
    addAnnotation,
    updateAnnotationShape,
    removeAnnotation,
    setActiveAnnotationTool,
    // Blur
    blurRegions,
    addBlurRegion,
    updateBlurRegion,
    removeBlurRegion,
    browserHeaderSize,
    showRulers,
    showGrid,
    rulerInterval,
    selectedOverlayId,
    setSelectedOverlayId,
    isMainImageSelected,
    setIsMainImageSelected,
  } = useImageStore(
    useShallow((state) => ({
      backgroundConfig: state.backgroundConfig,
      uploadedImageUrl: state.uploadedImageUrl,
      backgroundBorderRadius: state.backgroundBorderRadius,
      backgroundBlur: state.backgroundBlur,
      backgroundNoise: state.backgroundNoise,
      imageFilters: state.imageFilters,
      textOverlays: state.textOverlays,
      imageOverlays: state.imageOverlays,
      mockups: state.mockups,
      editorMode: state.editorMode,
      imageBorder: state.imageBorder,
      updateTextOverlay: state.updateTextOverlay,
      updateImageOverlay: state.updateImageOverlay,
      removeImageOverlay: state.removeImageOverlay,
      addImageOverlay: state.addImageOverlay,
      removeMockup: state.removeMockup,
      annotations: state.annotations,
      activeAnnotationTool: state.activeAnnotationTool,
      selectedAnnotationId: state.selectedAnnotationId,
      setSelectedAnnotationId: state.setSelectedAnnotationId,
      annotationDefaults: state.annotationDefaults,
      addAnnotation: state.addAnnotation,
      updateAnnotationShape: state.updateAnnotation,
      removeAnnotation: state.removeAnnotation,
      setActiveAnnotationTool: state.setActiveAnnotationTool,
      blurRegions: state.blurRegions,
      addBlurRegion: state.addBlurRegion,
      updateBlurRegion: state.updateBlurRegion,
      removeBlurRegion: state.removeBlurRegion,
      browserHeaderSize: state.browserHeaderSize,
      showRulers: state.showRulers,
      showGrid: state.showGrid,
      rulerInterval: state.rulerInterval,
      selectedOverlayId: state.selectedOverlayId,
      setSelectedOverlayId: state.setSelectedOverlayId,
      isMainImageSelected: state.isMainImageSelected,
      setIsMainImageSelected: state.setIsMainImageSelected,
    }))
  );

  // Split overlays into front (default) and back (behind main image)
  const backOverlays = imageOverlays.filter((o) => o.layer === 'back');
  const frontOverlays = imageOverlays.filter((o) => o.layer !== 'back');

  const frame = {
    enabled: imageBorder.enabled,
    type: imageBorder.type,
    width: imageBorder.width,
    color: imageBorder.color,
    padding: imageBorder.padding,
    title: imageBorder.title,
    opacity: imageBorder.opacity,
  };

  const mainDepth = useLayerDepth('__main__');
  const hasDeviceScene = editorMode === "device" && hasVisibleMockups(mockups);
  const hasSourceImage = !!uploadedImageUrl && !!screenshot.src && shouldRenderSourceImage(editorMode, mockups);
  const mainChrome = useMainChromeFrame();
  useFrameToneSync();
  const selectedDeviceId = useDeviceUIStore((state) => state.selectedDeviceId);
  const setSelectedDeviceId = useDeviceUIStore((state) => state.setSelectedDeviceId);
  const setEditingScreenDeviceId = useDeviceUIStore((state) => state.setEditingScreenDeviceId);
  const responsiveDimensions = useResponsiveCanvasDimensions();

  // Keep pixel-based layers in the draft's coordinate system; only the preview scales.
  const [referenceWidth] = useState(() => useImageStore.getState().canvasDimensions?.canvasW ?? 960);

  const [patternImage, setPatternImage] = useState<HTMLCanvasElement | null>(
    null
  );
  const [noiseTexture, setNoiseTexture] = useState<HTMLCanvasElement | null>(
    null
  );

  const selectedTextId = useImageStore((state) => state.selectedTextId);
  const setSelectedTextId = useImageStore((state) => state.setSelectedTextId);
  const selectedBlurId = useImageStore((state) => state.selectedBlurId);
  const setSelectedBlurId = useImageStore((state) => state.setSelectedBlurId);

  // 3D transform drag state — differentiates click (select) from drag (move)
  const [is3DDragging, setIs3DDragging] = useState(false);
  const [is3DPointerDown, setIs3DPointerDown] = useState(false);
  const drag3DStartRef = useRef<{
    clientX: number; clientY: number;
    tX: number; tY: number;
    moved: boolean;
  } | null>(null);

  const handle3DDragDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const p3d = useImageStore.getState().perspective3D;
    drag3DStartRef.current = {
      clientX: e.clientX,
      clientY: e.clientY,
      tX: p3d.translateX,
      tY: p3d.translateY,
      moved: false,
    };
    setIs3DPointerDown(true);
    // Select the image on click/drag start
    setIsMainImageSelected(true);
    setSelectedOverlayId(null);
    setSelectedTextId(null);
  }, [setIsMainImageSelected, setSelectedOverlayId, setSelectedTextId]);

  useEffect(() => {
    const onReorder = (event: KeyboardEvent) => {
      if (event.defaultPrevented || shouldIgnoreEditorShortcut(event) || !event.altKey || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
      const state = useImageStore.getState();
      const id = state.selectedElementId ?? state.selectedOverlayId ?? state.selectedAnnotationId ?? state.selectedBlurId ?? useDeviceUIStore.getState().selectedDeviceId ?? (state.isMainImageSelected ? '__main__' : null);
      if (!id) return;
      event.preventDefault();
      reorderLayer(id, event.key === 'ArrowUp' ? 'up' : 'down');
    };
    window.addEventListener('keydown', onReorder);
    return () => window.removeEventListener('keydown', onReorder);
  }, []);
  useEffect(() => {
    if (!is3DPointerDown) return;

    const DRAG_THRESHOLD = 3;
    let rafId: number | null = null;
    let latestEvent: PointerEvent | null = null;

    const applyMove = () => {
      rafId = null;
      const e = latestEvent;
      const s = drag3DStartRef.current;
      if (!e || !s) return;

      const dx = e.clientX - s.clientX;
      const dy = e.clientY - s.clientY;

      // Only start actual drag after threshold — clicks pass through
      if (!s.moved && Math.sqrt(dx * dx + dy * dy) < DRAG_THRESHOLD) return;
      if (!s.moved) {
        s.moved = true;
        setIs3DDragging(true);
      }

      const sensitivity = 0.15;
      const newTX = Math.max(-30, Math.min(30, s.tX + dx * sensitivity));
      const newTY = Math.max(-30, Math.min(30, s.tY + dy * sensitivity));

      useImageStore.getState().setPerspective3D({
        translateX: Math.round(newTX * 10) / 10,
        translateY: Math.round(newTY * 10) / 10,
      });
    };

    const handleMove = (e: PointerEvent) => {
      latestEvent = e;
      if (rafId === null) rafId = requestAnimationFrame(applyMove);
    };

    const handleUp = () => {
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        applyMove();
      }
      setIs3DDragging(false);
      setIs3DPointerDown(false);
      drag3DStartRef.current = null;
    };

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    window.addEventListener('pointercancel', handleUp);

    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
      window.removeEventListener('pointercancel', handleUp);
    };
  }, [is3DPointerDown]);

  const containerWidth = referenceWidth;
  const containerHeight = referenceWidth * responsiveDimensions.originalHeight / responsiveDimensions.originalWidth;
  const previewScale = responsiveDimensions.width / referenceWidth;

  const loadedOverlayImages = useOverlayImages(imageOverlays);

  // Update global reference for export
  useEffect(() => {
    if (canvasContainerRef.current) {
      globalCanvasContainer = canvasContainerRef.current;
    }
    return () => {
      globalCanvasContainer = null;
    };
  }, []);

  // Clear selection when clicking outside of canvas
  useEffect(() => {
    const handlePointerDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (!target) return;

      const container = containerRef.current;
      if (!container) return;

      if (!container.contains(target)) {
        // Don't deselect when interacting with editor panel controls
        // (sliders, inputs, buttons, etc.) so users can tweak selected items
        const el = target as HTMLElement;
        if (el.closest?.('[data-slot="slider"], input, textarea, select, label, [contenteditable="true"], button, [role="button"], [role="listbox"], [data-radix-collection-item], .moveable-control-box, [data-resize-handle], [data-keep-selection]')) return;

        setSelectedOverlayId(null);
        setIsMainImageSelected(false);
        setSelectedTextId(null);
        setSelectedBlurId(null);
        setSelectedAnnotationId(null);
        setSelectedDeviceId(null);
        useImageStore.getState().setSelectedElementId(null);
      }
    };

    document.addEventListener('pointerdown', handlePointerDown, true);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
    };
  }, [setSelectedAnnotationId, setSelectedDeviceId, setSelectedOverlayId, setIsMainImageSelected, setSelectedBlurId, setSelectedTextId]);

  useEffect(() => {
    if (!selectedDeviceId) return;
    setSelectedOverlayId(null);
    setIsMainImageSelected(false);
    setSelectedTextId(null);
    setSelectedBlurId(null);
    setSelectedAnnotationId(null);
    useImageStore.getState().setSelectedElementId(null);
  }, [selectedDeviceId, setSelectedAnnotationId, setSelectedOverlayId, setIsMainImageSelected, setSelectedBlurId, setSelectedTextId]);

  // Panel selection must clear the same competing selections as a canvas click.
  useEffect(() => {
    if (!selectedOverlayId && !isMainImageSelected) return;
    setSelectedTextId(null);
    setSelectedBlurId(null);
    setSelectedAnnotationId(null);
    setSelectedDeviceId(null);
  }, [selectedOverlayId, isMainImageSelected, setSelectedAnnotationId, setSelectedDeviceId, setSelectedBlurId, setSelectedTextId]);

  // Selection shortcuts; history lives in the always-mounted editor header.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (shouldIgnoreEditorShortcut(e)) return;

      // Delete selected overlay or main image (only when not typing)
      if (e.key === "Delete" || e.key === "Backspace") {
        if (selectedDeviceId && editorMode === "device") {
          e.preventDefault();
          removeMockup(selectedDeviceId);
          setSelectedDeviceId(null);
        } else if (selectedOverlayId) {
          e.preventDefault();
          removeImageOverlay(selectedOverlayId);
          setSelectedOverlayId(null);
        } else if (selectedTextId) {
          e.preventDefault();
          useImageStore.getState().removeTextOverlay(selectedTextId);
          setSelectedTextId(null);
        } else if (isMainImageSelected) {
          e.preventDefault();
          removeScreenshot();
        }
      }

      if (e.key === "Escape") {
        e.preventDefault();
        setSelectedOverlayId(null);
        setIsMainImageSelected(false);
        setSelectedTextId(null);
        setSelectedBlurId(null);
        setSelectedAnnotationId(null);
        setSelectedDeviceId(null);
        useImageStore.getState().setSelectedElementId(null);
        setEditingScreenDeviceId(null);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [editorMode, isMainImageSelected, removeImageOverlay, removeMockup, selectedDeviceId, selectedOverlayId, selectedTextId, setSelectedDeviceId, setSelectedOverlayId, setIsMainImageSelected, setSelectedAnnotationId, setEditingScreenDeviceId, setSelectedBlurId, setSelectedTextId]);

  // Get selected overlay for toolbar positioning
  const selectedOverlay = selectedOverlayId
    ? imageOverlays.find(o => o.id === selectedOverlayId)
    : null;

  // Handle duplicate overlay
  const handleDuplicateOverlay = () => {
    if (!selectedOverlay) return;

    const { id: _id, ...overlayWithoutId } = selectedOverlay;
    addImageOverlay({
      ...overlayWithoutId,
      position: {
        x: selectedOverlay.position.x + 30,
        y: selectedOverlay.position.y + 30,
      },
    });
  };

  // Handle delete overlay
  const handleDeleteOverlay = () => {
    if (!selectedOverlayId) return;
    removeImageOverlay(selectedOverlayId);
    setSelectedOverlayId(null);
  };

  useEffect(() => {
    if (backgroundNoise > 0) {
      const intensity = backgroundNoise / 100;
      const noiseCanvas = generateNoiseTexture(200, 200, intensity);
      setNoiseTexture(noiseCanvas);
    } else {
      setNoiseTexture(null);
    }
  }, [backgroundNoise]);

  useEffect(() => {
    if (!patternStyle.enabled) {
      setPatternImage(null);
      return;
    }

    const newPattern = generatePattern(
      patternStyle.type,
      patternStyle.scale,
      patternStyle.spacing,
      patternStyle.color,
      patternStyle.rotation,
      patternStyle.blur
    );
    setPatternImage(newPattern);
  }, [
    patternStyle.enabled,
    patternStyle.type,
    patternStyle.scale,
    patternStyle.spacing,
    patternStyle.color,
    patternStyle.rotation,
    patternStyle.blur,
  ]);

  const dimensions = calculateCanvasDimensions(
    layoutImage,
    containerWidth,
    containerHeight,
    { width: 1920, height: 1080 },
    { padding: canvasPadding },
    screenshot,
    frame,
    browserHeaderSize,
    mainChrome
  );

  const {
    canvasW,
    canvasH,
    imageScaledW,
    imageScaledH,
    framedW,
    framedH,
    frameOffset,
    windowPadding,
    windowHeader,
    eclipseBorder,
    groupCenterX,
    groupCenterY,
  } = dimensions;

  // Store canvas dimensions so editor panels can calculate position presets
  const setCanvasDimensions = useImageStore((s) => s.setCanvasDimensions);
  useEffect(() => {
    setCanvasDimensions({ canvasW, canvasH, framedW, framedH });
  }, [canvasW, canvasH, framedW, framedH, setCanvasDimensions]);

  const showFrame = frame.enabled && frame.type !== "none";
  const { perspective3D, imageOpacity } = imageWithMotion(presetMotion, imageLayerMotion, {
    canvasH,
    canvasW,
    framedH,
    framedW,
  });
  const imageObjectPosition = imageScroll
    ? scrollObjectPosition(
        imageScroll.progress,
        imageScroll.scroll.direction,
        coverOverflow(
          { height: image.naturalHeight, width: image.naturalWidth },
          { height: imageScaledH, width: imageScaledW }
        )[imageScroll.scroll.direction === "vertical" ? "y" : "x"]
      )
    : undefined;

  const hasCallouts = useImageStore((state) => state.elements.some((element) => element.type === 'callout' && element.visible));
  const compositeSource = useCompositeSource(canvasContainerRef, canvasW, canvasH, hasCallouts);
  const geometry: CanvasGeometry = {
    canvasH,
    canvasW,
    imageFilter: imageFilterCss(imageFilters),
    imageNaturalSize: { height: image.naturalHeight, width: image.naturalWidth },
    imageObjectPosition,
    imageRect: hasSourceImage
      ? mainImageRect(dimensions, screenshot, showFrame ? frame.type : "none")
      : null,
    imageSrc: hasCallouts ? compositeSource : uploadedImageUrl,
    ...(hasCallouts ? {
      imageRect: { x: 0, y: 0, width: canvasW, height: canvasH },
      imageFilter: undefined,
      imageObjectPosition: undefined,
    } : {}),
  };

  let selectedSelector: string | null = null;
  if (isMainImageSelected) {
    selectedSelector = '[data-main-image-layer="true"]';
  } else if (selectedOverlayId) {
    selectedSelector = `[data-overlay-id="${CSS.escape(selectedOverlayId)}"]`;
  }

  const has3DTransform =
    perspective3D.rotateX !== 0 ||
    perspective3D.rotateY !== 0 ||
    perspective3D.rotateZ !== 0 ||
    perspective3D.translateX !== 0 ||
    perspective3D.translateY !== 0 ||
    perspective3D.scale !== 1;

  // Deselect everything on mousedown on the canvas background.
  // Child elements (image, overlays) call e.stopPropagation() on mousedown,
  // so this only fires when clicking empty canvas area.
  const handleCanvasDeselect = (e: React.PointerEvent) => {
    // Don't deselect when interacting with resize/rotate handles
    const target = e.target as HTMLElement;
    if (target.closest?.('.moveable-control-box, [data-resize-handle]')) return;

    setSelectedOverlayId(null);
    setIsMainImageSelected(false);
    setSelectedTextId(null);
    setSelectedBlurId(null);
    setSelectedAnnotationId(null);
    setEditingScreenDeviceId(null);
    setSelectedDeviceId(null);
    useImageStore.getState().setSelectedElementId(null);
  };

  return (
    <div
      ref={containerRef}
      tabIndex={-1}
      onPointerDownCapture={(event) => {
        // Canvas objects prevent pointer defaults while dragging; move focus
        // out of a previously edited panel field before handling shortcuts.
        if (!shouldIgnoreEditorShortcut(event)) event.currentTarget.focus({ preventScroll: true });
      }}
      className="relative h-full w-full"
      style={{
        lineHeight: 0,
        width: containerWidth,
        height: containerHeight,
        transform: `scale(${previewScale})`,
        transformOrigin: "top left",
      }}
    >
      {showRulers && (
        <CanvasRulers
          canvasRef={canvasContainerRef}
          canvasW={canvasW}
          majorEvery={rulerInterval}
          selectedSelector={selectedSelector}
        />
      )}
      <HTMLCanvasRenderer
        ref={canvasContainerRef}
        width={canvasW}
        height={canvasH}
        borderRadius={backgroundBorderRadius}
        onPointerDown={handleCanvasDeselect}
        style={{
          isolation: "isolate",
        }}
      >
        <HTMLBackgroundLayer
          backgroundConfig={backgroundConfig}
          backgroundBlur={backgroundBlur}
          backgroundBorderRadius={backgroundBorderRadius}
          width={canvasW}
          height={canvasH}
          noiseTexture={noiseTexture}
          backgroundNoise={backgroundNoise}
        />

        <HTMLPatternLayer
          patternImage={patternImage}
          width={canvasW}
          height={canvasH}
          patternOpacity={patternStyle.opacity}
        />

        {hasSourceImage ? <Perspective3DOverlay
          has3DTransform={has3DTransform}
          perspective3D={perspective3D}
          screenshot={screenshot}
          shadow={shadow}
          frame={frame}
          chrome={mainChrome}
          chromeScale={browserHeaderSize / 100}
          showFrame={showFrame}
          framedW={framedW}
          framedH={framedH}
          frameOffset={frameOffset}
          windowPadding={windowPadding}
          windowHeader={windowHeader}
          eclipseBorder={eclipseBorder}
          imageScaledW={imageScaledW}
          imageScaledH={imageScaledH}
          groupCenterX={groupCenterX}
          groupCenterY={groupCenterY}
          canvasW={canvasW}
          canvasH={canvasH}
          image={image}
          imageOpacity={imageOpacity}
          imageFilters={imageFilters}
          imageObjectPosition={imageObjectPosition}
        /> : null}

        {hasSourceImage && has3DTransform && (
          <div
            onPointerDown={handle3DDragDown}
            style={{
              position: 'absolute',
              left: 0,
              top: 0,
              width: `${canvasW}px`,
              height: `${canvasH}px`,
              zIndex: mainDepth + 0.1,
              cursor: is3DDragging ? 'grabbing' : 'grab',
              touchAction: 'none',
            }}
          />
        )}

        {backOverlays.length > 0 && (
          <HTMLImageOverlayLayer
            imageOverlays={backOverlays}
            loadedOverlayImages={loadedOverlayImages}
            selectedOverlayId={selectedOverlayId}
            setSelectedOverlayId={setSelectedOverlayId}
            setIsMainImageSelected={setIsMainImageSelected}
            setSelectedTextId={setSelectedTextId}
            updateImageOverlay={updateImageOverlay}
            onDuplicate={handleDuplicateOverlay}
            onDelete={handleDeleteOverlay}
            zIndex={10}
          />
        )}

        {hasSourceImage && !has3DTransform && (
          <>
            <HTMLMainImageLayer
              image={image}
              canvasW={canvasW}
              canvasH={canvasH}
              framedW={framedW}
              framedH={framedH}
              frameOffset={frameOffset}
              windowPadding={windowPadding}
              windowHeader={windowHeader}
              imageScaledW={imageScaledW}
              imageScaledH={imageScaledH}
              screenshot={screenshot}
              frame={frame}
              chrome={mainChrome}
              chromeScale={browserHeaderSize / 100}
              shadow={shadow}
              showFrame={showFrame}
              imageOpacity={imageOpacity}
              imageFilters={imageFilters}
              imageObjectPosition={imageObjectPosition}
              isMainImageSelected={isMainImageSelected}
              setIsMainImageSelected={setIsMainImageSelected}
              setSelectedOverlayId={setSelectedOverlayId}
              setSelectedTextId={setSelectedTextId}
              setScreenshot={setImagePlacement}
            />
          </>
        )}

        {hasDeviceScene ? (
          <MockupSceneRenderer canvasWidth={canvasW} canvasHeight={canvasH} />
        ) : null}

        <HTMLTextOverlayLayer
          textOverlays={textOverlays}
          canvasW={canvasW}
          canvasH={canvasH}
          selectedTextId={selectedTextId}
          setSelectedTextId={setSelectedTextId}
          setSelectedOverlayId={setSelectedOverlayId}
          setIsMainImageSelected={setIsMainImageSelected}
          updateTextOverlay={updateTextOverlay}
        />

        <HTMLImageOverlayLayer
          imageOverlays={frontOverlays}
          loadedOverlayImages={loadedOverlayImages}
          selectedOverlayId={selectedOverlayId}
          setSelectedOverlayId={setSelectedOverlayId}
          setIsMainImageSelected={setIsMainImageSelected}
          setSelectedTextId={setSelectedTextId}
          updateImageOverlay={updateImageOverlay}
          onDuplicate={handleDuplicateOverlay}
          onDelete={handleDeleteOverlay}
        />

        <CanvasGeometryContext.Provider value={geometry}>
          <ElementLayer zIndex={205} />
        </CanvasGeometryContext.Provider>

        <CaptionLayer canvasW={canvasW} canvasH={canvasH} />

        <HTMLBlurRegionLayer
          blurRegions={blurRegions}
          selectedBlurId={selectedBlurId}
          setSelectedBlurId={setSelectedBlurId}
          updateBlurRegion={updateBlurRegion}
          removeBlurRegion={removeBlurRegion}
        />

        <SVGAnnotationLayer
          annotations={annotations}
          activeAnnotationTool={activeAnnotationTool}
          selectedAnnotationId={selectedAnnotationId}
          setSelectedAnnotationId={setSelectedAnnotationId}
          canvasW={canvasW}
          canvasH={canvasH}
          addAnnotation={addAnnotation}
          updateAnnotation={updateAnnotationShape}
          removeAnnotation={removeAnnotation}
          setActiveAnnotationTool={setActiveAnnotationTool}
          annotationDefaults={annotationDefaults}
          onDrawBlurRegion={(rect) => {
            addBlurRegion({
              position: { x: rect.x, y: rect.y },
              size: { width: rect.w, height: rect.h },
              blurAmount: 10,
              isVisible: true,
              style: 'mosaic',
            });
          }}
        />


        {showGrid && <HTMLGridLayer canvasW={canvasW} canvasH={canvasH} />}
        <CanvasGuidesLayer canvasW={canvasW} canvasH={canvasH} />
        <SnapAlignmentGuides />
      </HTMLCanvasRenderer>
    </div>
  );
}

export function getCanvasContainer(): HTMLDivElement | null {
  return globalCanvasContainer;
}

type ClientCanvasProps = {
  embedded?: boolean;
  onReady?: () => void;
};

export default function ClientCanvas({
  embedded = false,
  onReady,
}: ClientCanvasProps) {
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [loadError, setLoadError] = useState(false);
  const uploadedImageUrl = useImageStore((state) => state.uploadedImageUrl);
  const editorMode = useImageStore((state) => state.editorMode);
  const mockups = useImageStore((state) => state.mockups);
  const hasContent = useImageStore(hasCanvasContent);
  const hasSourceImage = !!uploadedImageUrl
    && shouldRenderSourceImage(editorMode, mockups);

  // Load primary image from screenshot.src
  useEffect(() => {
    setLoadError(false);

    if (!hasContent && !embedded) {
      setImage(null);
      return;
    }

    const img = new window.Image();
    img.crossOrigin = "anonymous";

    // An image that never loads is dropped so the upload state shows again.
    const dropBrokenImage = () => {
      setLoadError(true);
      if (hasSourceImage) useImageStore.getState().setUploadedImageUrl(null, null);
    };

    const timeoutId = setTimeout(() => {
      if (!img.complete) {
        console.warn("Image load timeout");
        dropBrokenImage();
      }
    }, 10000);

    img.onload = () => {
      clearTimeout(timeoutId);
      setImage(img);
    };

    img.onerror = () => {
      clearTimeout(timeoutId);
      console.warn("Image load error");
      dropBrokenImage();
    };

    img.src = hasSourceImage && uploadedImageUrl
      ? uploadedImageUrl
      : "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='1600' height='1200'/%3E";

    return () => {
      clearTimeout(timeoutId);
    };
  }, [embedded, hasContent, hasSourceImage, uploadedImageUrl]);

  useEffect(() => {
    if (image) {
      onReady?.();
    }
  }, [image, onReady]);

  if (loadError || (!hasContent && !embedded)) {
    return null;
  }

  if (!image) {
    if (embedded) return null;
    return (
      <CanvasStageShell breathe showBackground className="overflow-hidden" />
    );
  }

  return <CanvasRenderer image={image} />;
}
