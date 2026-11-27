import { waitForCompositeSources } from '@/components/canvas/elements/use-composite-source'
/**
 * Export service for handling image exports (fully in-browser)
 *
 * HTML/CSS Canvas Architecture:
 * - Uses pure HTML/CSS for ALL rendering (background, patterns, noise, images, text, overlays)
 * - Uses html2canvas for capturing the canvas container
 * - Uses modern-screenshot for 3D perspective transforms (HTML fallback)
 * - Uses Web Workers for heavy image processing to prevent UI blocking
 *
 * All export operations run client-side without external services.
 * Cloudinary is optional and only used for image optimization when configured.
 */

import { domToCanvas } from 'modern-screenshot';
import { cleanExportClone, shouldIncludeInExport } from './export-filter';
import { getMosaicGrid } from './mosaic';
import { processWithSharp } from './sharp-client';
import type { ExportFormat, QualityPreset } from './types';
import { useImageStore, type ImageState } from '@/lib/store';

export interface ExportOptions {
  format: ExportFormat;
  qualityPreset: QualityPreset;
  scale: number;
  exportWidth: number;
  exportHeight: number;
  /** Skip Sharp API (e.g. for clipboard copies where speed matters more than compression) */
  skipSharp?: boolean;
}

export interface ExportResult {
  dataURL: string;
  blob: Blob;
}

/**
 * Apply blur regions to the exported canvas.
 * CSS backdrop-filter doesn't render in domToCanvas, so we apply it manually.
 */
function applyBlurRegionsToCanvas(
  canvas: HTMLCanvasElement,
  containerWidth: number,
  containerHeight: number
): void {
  const { blurRegions } = useImageStore.getState();
  if (!blurRegions || blurRegions.length === 0) return;

  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  // Scale factor from CSS pixels to canvas pixels
  const scaleX = canvas.width / containerWidth;
  const scaleY = canvas.height / containerHeight;

  // Create a copy of the current canvas to use as blur source
  const sourceCanvas = document.createElement('canvas');
  sourceCanvas.width = canvas.width;
  sourceCanvas.height = canvas.height;
  const sourceCtx = sourceCanvas.getContext('2d');
  if (!sourceCtx) return;
  sourceCtx.drawImage(canvas, 0, 0);

  const mosaicCanvas = document.createElement('canvas');
  const mosaicCtx = mosaicCanvas.getContext('2d');

  for (const region of blurRegions) {
    if (!region.isVisible) continue;

    const rx = region.position.x * scaleX;
    const ry = region.position.y * scaleY;
    const rw = region.size.width * scaleX;
    const rh = region.size.height * scaleY;
    const blurPx = region.blurAmount * Math.max(scaleX, scaleY);
    // A perfectly straight drag draws a zero-area region; drawing a 0x0 mosaic canvas would throw
    if (rw <= 0 || rh <= 0) continue;

    ctx.save();
    ctx.beginPath();
    ctx.roundRect(rx, ry, rw, rh, 4 * Math.max(scaleX, scaleY));
    ctx.clip();
    if (region.style === 'mosaic' && mosaicCtx) {
      const { columns, rows } = getMosaicGrid(rw, rh, blurPx);
      const coveredW = columns * blurPx;
      const coveredH = rows * blurPx;
      mosaicCanvas.width = columns;
      mosaicCanvas.height = rows;
      // Downscaling with smoothing averages each block; scaling back up without it keeps the edges hard
      mosaicCtx.imageSmoothingQuality = 'high';
      mosaicCtx.drawImage(sourceCanvas, rx, ry, coveredW, coveredH, 0, 0, columns, rows);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(mosaicCanvas, rx, ry, coveredW, coveredH);
    } else {
      ctx.filter = `blur(${blurPx}px)`;
      ctx.drawImage(sourceCanvas, 0, 0);
      ctx.filter = 'none';
    }
    ctx.restore();
  }
}

/**
 * Capture 3D transformed element using modern-screenshot
 */
async function capture3DTransformWithModernScreenshot(
  element: HTMLElement,
  scale: number,
  skipDelay: boolean = false
): Promise<HTMLCanvasElement> {
  await waitForCompositeSources();
  const overlayElement = element.querySelector('[data-3d-overlay="true"]') as HTMLElement;
  if (!overlayElement) {
    throw new Error('3D overlay element not found');
  }

  if (!skipDelay) {
    // Wait for styles to apply (only needed for first/single exports, not video frames)
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }

  const elementRect = { width: parseFloat(element.style.width), height: parseFloat(element.style.height) };

  const canvas = await domToCanvas(element, {
    scale: scale,
    width: elementRect.width,
    height: elementRect.height,
    backgroundColor: null,
    fetch: { requestInit: { mode: 'cors', cache: 'no-cache' } },
    filter: shouldIncludeInExport,
    onCloneNode: cleanExportClone,
  });

  // Apply blur regions as post-processing
  applyBlurRegionsToCanvas(canvas, elementRect.width, elementRect.height);

  return canvas;
}

/**
 * Export HTML canvas container using modern-screenshot (domToCanvas)
 * This provides better CSS fidelity than html2canvas, especially for:
 * - Box shadows
 * - CSS filters
 * - Border radius
 * - Transforms
 */

// Reusable output canvas to avoid GC pressure from repeated allocations
let reusableCanvas: HTMLCanvasElement | null = null;
let reusableCtx: CanvasRenderingContext2D | null = null;

async function exportHTMLCanvas(
  container: HTMLElement,
  targetWidth: number,
  targetHeight: number,
  scale: number,
  _borderRadius: number = 0,
  skipDelay: boolean = false
): Promise<HTMLCanvasElement> {
  // Get current container dimensions
  const containerRect = { width: parseFloat(container.style.width), height: parseFloat(container.style.height) };
  const originalWidth = containerRect.width;
  const originalHeight = containerRect.height;

  // Calculate scale factor to match export dimensions
  const scaleX = targetWidth / originalWidth;
  const scaleY = targetHeight / originalHeight;
  const exportScale = scale * Math.max(scaleX, scaleY);

  if (!skipDelay) {
    // Wait for any pending renders (only needed for first/single exports, not video frames)
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }

  // Use modern-screenshot for better CSS fidelity.
  // onCloneNode overrides overflow:hidden → visible on the canvas
  // container so that CSS drop-shadow filters render fully instead
  // of being hard-clipped at the canvas boundary.
  await waitForCompositeSources();
  const canvas = await domToCanvas(container, {
    scale: exportScale,
    backgroundColor: null,
    width: originalWidth,
    height: originalHeight,
    fetch: { requestInit: { mode: 'cors', cache: 'no-cache' } },
    // Exclude editor-only controls and blur regions. Blur is composited in a
    // post-processing pass because backdrop-filter cannot be rasterized here.
    filter: shouldIncludeInExport,
    onCloneNode: cleanExportClone,
  });

  // Apply blur regions as post-processing (CSS backdrop-filter doesn't export)
  applyBlurRegionsToCanvas(canvas, originalWidth, originalHeight);

  // Scale the canvas to match export dimensions
  const finalWidth = targetWidth * scale;
  const finalHeight = targetHeight * scale;

  // Reuse canvas when dimensions match (common for video frame sequences)
  if (skipDelay && reusableCanvas && reusableCtx &&
      reusableCanvas.width === finalWidth && reusableCanvas.height === finalHeight) {
    reusableCtx.clearRect(0, 0, finalWidth, finalHeight);
    reusableCtx.imageSmoothingEnabled = true;
    reusableCtx.imageSmoothingQuality = 'high';
    reusableCtx.drawImage(
      canvas,
      0, 0, canvas.width, canvas.height,
      0, 0, finalWidth, finalHeight
    );
    return reusableCanvas;
  }

  const finalCanvas = document.createElement('canvas');
  finalCanvas.width = finalWidth;
  finalCanvas.height = finalHeight;
  const ctx = finalCanvas.getContext('2d');

  if (!ctx) {
    throw new Error('Failed to get canvas context');
  }

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  ctx.drawImage(
    canvas,
    0, 0, canvas.width, canvas.height,
    0, 0, finalWidth, finalHeight
  );

  // Cache for video frame reuse
  if (skipDelay) {
    reusableCanvas = finalCanvas;
    reusableCtx = ctx;
  }

  return finalCanvas;
}

/**
 * Export element using HTML/CSS canvas with html2canvas
 */
export async function exportElement(
  elementId: string,
  options: ExportOptions,
  canvasContainer: HTMLElement | null,
  _backgroundConfig: unknown,
  backgroundBorderRadius: number,
  _textOverlays: unknown[] = [],
  _imageOverlays: unknown[] = [],
  perspective3D?: ImageState['perspective3D'],
  imageSrc?: string,
  screenshotRadius?: number,
  _backgroundBlur: number = 0,
  _backgroundNoise: number = 0,
  _backgroundOpacity: number = 1,
  onProgress?: (percent: number) => void
): Promise<ExportResult> {
  const report = onProgress ?? (() => {});

  // Stage 1: DOM preparation (0 → 10%)
  report(5);
  // Yield to let any pending React renders flush
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));

  const element = document.getElementById(elementId);
  if (!element) {
    throw new Error('Image render card not found. Please ensure an image is uploaded.');
  }

  const container = element.querySelector('[data-html-canvas="true"]') as HTMLElement;
  if (!container) {
    throw new Error('HTML canvas container not found');
  }

  report(10);

  try {
    const has3DTransform = perspective3D && imageSrc && container.querySelector('[data-3d-overlay="true"]') && (
      perspective3D.rotateX !== 0 ||
      perspective3D.rotateY !== 0 ||
      perspective3D.rotateZ !== 0 ||
      perspective3D.translateX !== 0 ||
      perspective3D.translateY !== 0 ||
      perspective3D.scale !== 1
    );

    let finalCanvas: HTMLCanvasElement;

    // Stage 2: Canvas capture (10 → 55%)
    report(15);

    if (has3DTransform) {
      try {
        finalCanvas = await capture3DTransformWithModernScreenshot(
          container,
          options.scale * Math.max(
            options.exportWidth / container.clientWidth,
            options.exportHeight / container.clientHeight
          )
        );

        report(50);

        if (finalCanvas.width !== options.exportWidth * options.scale ||
            finalCanvas.height !== options.exportHeight * options.scale) {
          const resizedCanvas = document.createElement('canvas');
          resizedCanvas.width = options.exportWidth * options.scale;
          resizedCanvas.height = options.exportHeight * options.scale;
          const ctx = resizedCanvas.getContext('2d');
          if (ctx) {
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = 'high';
            ctx.drawImage(
              finalCanvas,
              0, 0, finalCanvas.width, finalCanvas.height,
              0, 0, resizedCanvas.width, resizedCanvas.height
            );
            finalCanvas = resizedCanvas;
          }
        }
      } catch (error) {
        console.warn('Failed to capture 3D transform, falling back to html2canvas:', error);
        finalCanvas = await exportHTMLCanvas(
          container,
          options.exportWidth,
          options.exportHeight,
          options.scale,
          backgroundBorderRadius
        );
      }
    } else {
      finalCanvas = await exportHTMLCanvas(
        container,
        options.exportWidth,
        options.exportHeight,
        options.scale,
        backgroundBorderRadius
      );
    }

    report(55);

    // Stage 3: Sharp processing (55 → 90%)
    report(60);
    const sharpResult = await processWithSharp(
      finalCanvas,
      options.format,
      options.qualityPreset,
      { skipApi: options.skipSharp, onProgress: report }
    );

    report(90);

    if (!sharpResult.blob || sharpResult.blob.size === 0) {
      throw new Error('Failed to generate image');
    }

    report(95);
    return { dataURL: sharpResult.dataURL, blob: sharpResult.blob };
  } catch (error) {
    console.error('Export failed:', error);
    throw error;
  }
}

/**
 * Export element as raw canvas (no Sharp processing).
 * Used for video frame capture where FFmpeg handles final encoding.
 */
export async function exportElementAsCanvas(
  elementId: string,
  options: ExportOptions,
  canvasContainer: HTMLElement | null,
  backgroundBorderRadius: number,
  perspective3D?: ImageState['perspective3D'],
  imageSrc?: string,
): Promise<HTMLCanvasElement> {
  const element = document.getElementById(elementId);
  if (!element) {
    throw new Error('Image render card not found. Please ensure an image is uploaded.');
  }

  const container = element.querySelector('[data-html-canvas="true"]') as HTMLElement;
  if (!container) {
    throw new Error('HTML canvas container not found');
  }

  const has3DTransform = perspective3D && imageSrc && container.querySelector('[data-3d-overlay="true"]') && (
    perspective3D.rotateX !== 0 ||
    perspective3D.rotateY !== 0 ||
    perspective3D.rotateZ !== 0 ||
    perspective3D.translateX !== 0 ||
    perspective3D.translateY !== 0 ||
    perspective3D.scale !== 1
  );

  let finalCanvas: HTMLCanvasElement;

  if (has3DTransform) {
    try {
      finalCanvas = await capture3DTransformWithModernScreenshot(
        container,
        options.scale * Math.max(
          options.exportWidth / container.clientWidth,
          options.exportHeight / container.clientHeight
        ),
        true // skipDelay — video frames don't need style-settle waits
      );

      if (finalCanvas.width !== options.exportWidth * options.scale ||
          finalCanvas.height !== options.exportHeight * options.scale) {
        const resizedCanvas = document.createElement('canvas');
        resizedCanvas.width = options.exportWidth * options.scale;
        resizedCanvas.height = options.exportHeight * options.scale;
        const ctx = resizedCanvas.getContext('2d');
        if (ctx) {
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = 'high';
          ctx.drawImage(
            finalCanvas,
            0, 0, finalCanvas.width, finalCanvas.height,
            0, 0, resizedCanvas.width, resizedCanvas.height
          );
          finalCanvas = resizedCanvas;
        }
      }
    } catch (error) {
      console.warn('Failed to capture 3D transform, falling back to html2canvas:', error);
      finalCanvas = await exportHTMLCanvas(
        container,
        options.exportWidth,
        options.exportHeight,
        options.scale,
        backgroundBorderRadius,
        true // skipDelay
      );
    }
  } else {
    finalCanvas = await exportHTMLCanvas(
      container,
      options.exportWidth,
      options.exportHeight,
      options.scale,
      backgroundBorderRadius,
      true // skipDelay
    );
  }

  return finalCanvas;
}
