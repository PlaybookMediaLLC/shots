import { useExportProgress } from "@/hooks/useExportProgress";
import { streamSlidesToEncoder, streamAnimationToEncoder, switchToSlideAndWait, throwIfAborted } from "./render-slideFrame";
import { exportSlideFrameAsCanvas } from "./export-slideFrame";
import {
  type VideoFormat,
  type VideoQuality,
  isMp4Supported,
} from "./export/video-encoder";
import {
  WebCodecsVideoEncoder,
  isWebCodecsSupported,
  isH264Supported,
  isVpxSupported,
} from "./export/webcodecs-encoder";
import {
  FFmpegVideoEncoder,
  loadFFmpeg,
  terminateFFmpeg,
  type FFmpegFormat,
} from "./export/ffmpeg-encoder";
import { useImageStore } from "@/lib/store";
import { usePlaybackStore } from "@/lib/store/playback";
import { renderAudioMix } from "@/lib/animation/audio-mix";
import { isAudioEncodingSupported } from "./export/audio-track";

/**
 * The timeline's audio mixed for a video `durationMs` long, or null without
 * audio. A file that cannot be decoded fails the export rather than leaving
 * the video silent.
 */
async function mixExportAudio(durationMs: number): Promise<AudioBuffer | null> {
  return renderAudioMix(useImageStore.getState().motion.audio, durationMs);
}

/** True when WebCodecs can encode this audio for the container; FFmpeg takes it otherwise. */
async function canEncodeAudio(container: "mp4" | "webm", audio: AudioBuffer | null): Promise<boolean> {
  return !audio || (await isAudioEncodingSupported(container, audio));
}

/**
 * True when an error was raised because the user cancelled the export.
 * Callers use this to skip "export failed" messaging.
 */
export function isExportAborted(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

const ANIMATION_FPS = 60;
const SLIDESHOW_FPS = 30; // Static frames don't need 60fps — halves all frame work

// Bitrates for different quality levels (for WebCodecs)
const QUALITY_BITRATES: Record<VideoQuality, number> = {
  high: 25_000_000,   // 25 Mbps
  medium: 10_000_000, // 10 Mbps
  low: 5_000_000,     // 5 Mbps
};

// Encoder types
export type EncoderType = 'auto' | 'ffmpeg' | 'webcodecs' | 'mediarecorder';

// Extended format type that includes GIF (FFmpeg only)
export type ExtendedVideoFormat = VideoFormat | 'gif';

export interface VideoExportOptions {
  /** Receive the file instead of downloading it, as when saving to the workspace. */
  onFile?: (blob: Blob) => void;
  /** Duration per slide for this export only, in seconds. */
  slideDuration?: number;
  format?: ExtendedVideoFormat;
  quality?: VideoQuality;
  encoder?: EncoderType; // Which encoder to use (default: 'auto')
  /** Frames per second (default 60 for animation, 30 for slideshows). */
  fps?: number;
  /** GIF only: scale the output down to at most this width, in px. */
  maxWidth?: number;
  /** Download name (default `shots-<kind>-<time>.<ext>`). */
  fileName?: string;
}

/** Per-export encoder settings, resolved from {@link VideoExportOptions}. */
type EncodeSettings = { slideDuration?: number; fileName?: string; fps: number; maxWidth?: number; onFile?: (blob: Blob) => void };

/** The encoder's output size: the frame's, or a GIF scaled down to `maxWidth` (even sides). */
function encodeSize(canvas: HTMLCanvasElement, format: string, maxWidth?: number) {
  if (format !== "gif" || !maxWidth || canvas.width <= maxWidth) {
    return { width: canvas.width, height: canvas.height };
  }
  const width = Math.round(maxWidth / 2) * 2;
  return { width, height: Math.max(2, Math.round((canvas.height * width) / canvas.width / 2) * 2) };
}

/**
 * Check available encoders and their capabilities
 */
export async function checkEncoderSupport(): Promise<{
  ffmpeg: boolean;
  webcodecs: boolean;
  mediarecorder: boolean;
  recommended: EncoderType;
}> {
  const webcodecs = isWebCodecsSupported() && await isH264Supported();

  return {
    ffmpeg: true, // Always available (WASM)
    webcodecs,
    mediarecorder: true, // Always available
    recommended: 'ffmpeg', // FFmpeg is most reliable
  };
}

/**
 * Pre-load FFmpeg for faster exports
 * Call this early (e.g., when user opens export dialog)
 */
export async function preloadFFmpeg(
  onProgress?: (progress: number) => void
): Promise<void> {
  await loadFFmpeg(onProgress);
}

/**
 * Save current store state for rollback on error
 */
function saveStoreState() {
  const { playhead, isPlaying } = usePlaybackStore.getState();
  usePlaybackStore.setState({ isPlaying: false });
  return { activeSlideId: useImageStore.getState().activeSlideId, isPlaying, playhead };
}

/**
 * Restore store state (used on export error)
 */
function restoreStoreState(saved: ReturnType<typeof saveStoreState>) {
  usePlaybackStore.setState({ isPlaying: saved.isPlaying, playhead: saved.playhead });
  if (saved.activeSlideId) {
    useImageStore.getState().setActiveSlide(saved.activeSlideId);
  }
}

/**
 * Trigger file download from blob
 */
function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Mark the export done, trigger the file download, and return the result —
 * the common tail shared by every encoder path.
 */
function finishExport<F extends string>(
  progress: ReturnType<typeof useExportProgress.getState>,
  blob: Blob,
  namePrefix: "video" | "animation",
  format: F,
  fileName?: string,
  onFile?: (blob: Blob) => void
): { format: F } {
  progress.done();
  if (onFile) onFile(blob);
  else downloadBlob(blob, fileName ?? `shots-${namePrefix}-${Date.now()}.${format}`);
  return { format };
}

function getMediaRecorderCodec(preferFormat: VideoFormat): { mimeType: string; format: VideoFormat } {
  if (typeof MediaRecorder === "undefined") {
    throw new Error("MediaRecorder is not supported in this browser");
  }

  if (preferFormat === "mp4" && isMp4Supported()) {
    return { mimeType: "video/mp4; codecs=avc1", format: "mp4" };
  }
  if (MediaRecorder.isTypeSupported("video/webm; codecs=vp9")) {
    return { mimeType: "video/webm; codecs=vp9", format: "webm" };
  }
  return { mimeType: "video/webm; codecs=vp8", format: "webm" };
}

function yieldToMain(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestIdleCallback !== "undefined") {
      requestIdleCallback(() => resolve(), { timeout: 16 });
    } else {
      setTimeout(resolve, 0);
    }
  });
}

/**
 * Export slideshow as video — routes to appropriate encoder based on format
 */
export async function exportSlideshowVideo(options: VideoExportOptions = {}) {
  const { format = "mp4", quality = "high" } = options;
  if (options.slideDuration !== undefined && (!Number.isFinite(options.slideDuration) || options.slideDuration < 0.5 || options.slideDuration > 30)) {
    throw new Error('Slide duration must be between 0.5 and 30 seconds.');
  }
  const settings: EncodeSettings = { ...options, fps: options.fps ?? SLIDESHOW_FPS };
  const progress = useExportProgress.getState();
  const savedState = saveStoreState();

  const signal = progress.start();

  try {
    let result;
    const { slides, slideshow } = useImageStore.getState();
    const slideshowMs =
      (slides.length > 0
        ? slides.reduce((total, slide) => total + (options.slideDuration ?? (slide.duration || slideshow.defaultDuration || 2)), 0)
        : options.slideDuration ?? (slideshow.defaultDuration || 2)) * 1000;
    // GIF has no audio track; video formats carry the timeline's audio.
    const audio = format === "gif" ? null : await mixExportAudio(slideshowMs);

    if (format === "webm") {
      result = isWebCodecsSupported() && await isVpxSupported() && await canEncodeAudio("webm", audio)
        ? await exportSlideshowWithWebCodecs("webm", quality, progress, signal, settings, audio)
        : await exportSlideshowWithFFmpeg("webm", quality, progress, signal, settings, audio);
    } else if (format === "gif") {
      result = await exportSlideshowWithFFmpeg("gif", quality, progress, signal, settings);
    } else if (isWebCodecsSupported() && await isH264Supported() && await canEncodeAudio("mp4", audio)) {
      result = await exportSlideshowWithWebCodecs("mp4", quality, progress, signal, settings, audio);
    } else {
      result = await exportSlideshowWithFFmpeg("mp4", quality, progress, signal, settings, audio);
    }

    restoreStoreState(savedState);
    return result;
  } catch (error) {
    progress.done();
    restoreStoreState(savedState);
    throw error;
  }
}

/**
 * Export slideshow using WebCodecs (H.264/MP4 or VP9-VP8/WebM, hardware-accelerated where available)
 */
async function exportSlideshowWithWebCodecs(
  format: "mp4" | "webm",
  quality: VideoQuality,
  progress: ReturnType<typeof useExportProgress.getState>,
  signal: AbortSignal | undefined,
  settings: EncodeSettings,
  audio: AudioBuffer | null = null
) {
  const state: { encoder: WebCodecsVideoEncoder | null; frameIndex: number } = {
    encoder: null,
    frameIndex: 0,
  };

  try {
    await streamSlidesToEncoder(
      settings.fps,
      async (canvas, idx) => {
        if (!state.encoder) {
          state.encoder = new WebCodecsVideoEncoder({
            width: canvas.width,
            height: canvas.height,
            fps: settings.fps,
            bitrate: QUALITY_BITRATES[quality],
            container: format,
            audio,
          });
          await state.encoder.initialize();
        }

        await state.encoder.encodeFromCanvas(canvas, idx);
        state.frameIndex++;

        if (idx % 10 === 0) {
          await new Promise((r) => setTimeout(r, 0));
        }
      },

      (p) => progress.set(p * 0.9),
      signal,
      settings.slideDuration
    );

    if (!state.encoder) {
      throw new Error("No frames to export");
    }

    const blob = await state.encoder.finalize();
    return finishExport(progress, blob, "video", format, settings.fileName, settings.onFile);
  } catch (error) {
    state.encoder?.dispose();
    throw error;
  }
}

/**
 * Export slideshow using FFmpeg concat demuxer.
 * Writes 1 JPEG per unique slide + duration script — no duplicate frame files.
 */
async function exportSlideshowWithFFmpeg(
  format: FFmpegFormat,
  quality: VideoQuality,
  progress: ReturnType<typeof useExportProgress.getState>,
  signal: AbortSignal | undefined,
  settings: EncodeSettings,
  audio: AudioBuffer | null = null
) {
  const { slides, slideshow, uploadedImageUrl } = useImageStore.getState();

  // Build ordered slide list
  const orderedSlides = [...slides];
  const slideList: (typeof orderedSlides[number] | null)[] =
    orderedSlides.length > 0 ? orderedSlides : uploadedImageUrl ? [null] : [];

  if (slideList.length === 0) {
    throw new Error("No frames to export");
  }

  let encoder: FFmpegVideoEncoder | null = null;

  // Kill the WASM worker if the user cancels mid-encode (FFmpeg.exec can't be
  // interrupted otherwise). The next export reloads the core from cache.
  const onAbort = () => terminateFFmpeg();
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    for (let si = 0; si < slideList.length; si++) {
      throwIfAborted(signal);
      const slide = slideList[si];

      if (slide) {
        await switchToSlideAndWait(slide.id, slide.src, 50);
      }

      const canvas = await exportSlideFrameAsCanvas();

      if (!encoder) {
        encoder = new FFmpegVideoEncoder({
          ...encodeSize(canvas, format, settings.maxWidth),
          fps: settings.fps,
          format,
          quality,
          audio,
          onProgress: (p) => progress.set(40 + p * 0.6),
          onLog: () => {},
        });
        encoder.enableConcatMode();
        await encoder.initialize();
      }

      const duration = settings.slideDuration ?? (slide
        ? (slide.duration || slideshow.defaultDuration || 2)
        : (slideshow.defaultDuration || 2));

      await encoder.addSlide(canvas, duration);
      progress.set((si + 1) / slideList.length * 40);
    }

    if (!encoder) {
      throw new Error("No frames to export");
    }

    throwIfAborted(signal);
    const blob = await encoder.encode();
    return finishExport(progress, blob, "video", format, settings.fileName, settings.onFile);
  } catch (error) {
    // encode() cleans up on its own; this covers bailing out before encode().
    await encoder?.dispose();
    // terminateFFmpeg() rejects a mid-encode exec() with its own error — surface
    // it as a cancellation so callers don't treat it as a failure.
    if (signal?.aborted) throw new DOMException("Export cancelled", "AbortError");
    throw error;
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * Export animation as video
 *
 * Encoder options:
 * - 'ffmpeg': Best quality, supports MP4/WebM/GIF, runs in browser via WASM
 * - 'webcodecs': Fast, hardware-accelerated, MP4 only, Chrome/Edge/Safari
 * - 'mediarecorder': Fallback, WebM only in most browsers
 * - 'auto': Automatically picks the best available encoder (default)
 */
export async function exportAnimationVideo(options: VideoExportOptions = {}) {
  const { format = "mp4", quality = "high", encoder = "auto" } = options;
  const settings: EncodeSettings = { ...options, fps: options.fps ?? ANIMATION_FPS };
  const progress = useExportProgress.getState();
  const savedState = saveStoreState();

  const signal = progress.start();

  try {
    // Determine which encoder to use
    let selectedEncoder = encoder;

    if (encoder === "auto") {
      // Auto-select based on format and availability
      if (format === "gif") {
        selectedEncoder = "ffmpeg"; // Only FFmpeg supports GIF
      } else if ((format === "mp4" || format === "webm") && isWebCodecsSupported()) {
        selectedEncoder = "webcodecs"; // Prefer WebCodecs: hardware-accelerated, no WASM loading.
        // Precise codec availability (H.264/VP9/VP8) is checked below, with an FFmpeg fallback.
      } else {
        selectedEncoder = "ffmpeg";
      }
    }

    // The timeline's audio, mixed to the video's length. GIF has no audio track.
    const audio = format === "gif" ? null : await mixExportAudio(useImageStore.getState().timeline.duration);

    // Route to appropriate encoder
    let result;
    switch (selectedEncoder) {
      case "ffmpeg":
        result = await exportAnimationWithFFmpeg(format as FFmpegFormat, quality, progress, signal, settings, audio);
        break;

      case "webcodecs": {
        const webCodecsFormat = format === "webm" ? "webm" : "mp4";
        const codecSupported = webCodecsFormat === "webm" ? await isVpxSupported() : await isH264Supported();
        const audioSupported = await canEncodeAudio(webCodecsFormat, audio);
        if (isWebCodecsSupported() && codecSupported && audioSupported) {
          result = await exportAnimationWithWebCodecs(webCodecsFormat, quality, progress, signal, settings, audio);
          break;
        }
        // Fall through to FFmpeg when WebCodecs cannot encode the video or its audio.
        console.warn(
          audioSupported
            ? "WebCodecs not available, falling back to FFmpeg"
            : "This browser has no WebCodecs audio encoder for the container; encoding with FFmpeg"
        );
        result = await exportAnimationWithFFmpeg(format as FFmpegFormat, quality, progress, signal, settings, audio);
        break;
      }

      case "mediarecorder":
        if (audio) {
          throw new Error("The MediaRecorder encoder cannot include the timeline's audio. Export with the default encoder.");
        }
        result = await exportAnimationWithMediaRecorder(format as VideoFormat, quality, progress, signal, settings);
        break;

      default:
        result = await exportAnimationWithFFmpeg(format as FFmpegFormat, quality, progress, signal, settings, audio);
        break;
    }

    restoreStoreState(savedState);
    return result;
  } catch (error) {
    progress.done();
    restoreStoreState(savedState);
    throw error;
  }
}

/**
 * Export animation using FFmpeg WASM — streams frames directly to encoder
 */
async function exportAnimationWithFFmpeg(
  format: FFmpegFormat,
  quality: VideoQuality,
  progress: ReturnType<typeof useExportProgress.getState>,
  signal: AbortSignal | undefined,
  settings: EncodeSettings,
  audio: AudioBuffer | null = null
) {
  const state: { encoder: FFmpegVideoEncoder | null } = { encoder: null };

  // Kill the WASM worker if the user cancels mid-encode (FFmpeg.exec can't be
  // interrupted otherwise). The next export reloads the core from cache.
  const onAbort = () => terminateFFmpeg();
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    await streamAnimationToEncoder(
      settings.fps,
      async (canvas) => {
        // Initialize encoder on first frame
        if (!state.encoder) {
          state.encoder = new FFmpegVideoEncoder({
            ...encodeSize(canvas, format, settings.maxWidth),
            fps: settings.fps,
            format,
            quality,
            audio,
            onProgress: (p) => progress.set(40 + p * 0.6),
            onLog: () => {},
          });
          await state.encoder.initialize();
        }

        await state.encoder.addFrame(canvas);
      },
      (p) => progress.set(p * 0.4),
      signal
    );

    if (!state.encoder) {
      throw new Error("No frames to export");
    }

    throwIfAborted(signal);
    const blob = await state.encoder.encode();
    return finishExport(progress, blob, "animation", format, settings.fileName, settings.onFile);
  } catch (error) {
    // encode() cleans up on its own; this covers bailing out before encode().
    await state.encoder?.dispose();
    // terminateFFmpeg() rejects a mid-encode exec() with its own error — surface
    // it as a cancellation so callers don't treat it as a failure.
    if (signal?.aborted) throw new DOMException("Export cancelled", "AbortError");
    throw error;
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * Export animation using WebCodecs + mp4-muxer/webm-muxer — streams frames directly
 */
async function exportAnimationWithWebCodecs(
  format: "mp4" | "webm",
  quality: VideoQuality,
  progress: ReturnType<typeof useExportProgress.getState>,
  signal: AbortSignal | undefined,
  settings: EncodeSettings,
  audio: AudioBuffer | null = null
) {
  const state: { encoder: WebCodecsVideoEncoder | null; frameCount: number } = {
    encoder: null,
    frameCount: 0,
  };

  try {
    await streamAnimationToEncoder(
      settings.fps,
      async (canvas, frameIndex) => {
        // Initialize encoder on first frame
        if (!state.encoder) {
          state.encoder = new WebCodecsVideoEncoder({
            width: canvas.width,
            height: canvas.height,
            fps: settings.fps,
            bitrate: QUALITY_BITRATES[quality],
            container: format,
            audio,
          });
          await state.encoder.initialize();
        }

        await state.encoder.encodeFromCanvas(canvas, frameIndex);
        state.frameCount++;

        if (frameIndex % 10 === 0) {
          await new Promise((r) => setTimeout(r, 0));
        }
      },
      (p) => progress.set(p * 0.9),
      signal
    );

    if (!state.encoder) {
      throw new Error("No frames to export");
    }

    const blob = await state.encoder.finalize();
    return finishExport(progress, blob, "animation", format, settings.fileName, settings.onFile);
  } catch (error) {
    state.encoder?.dispose();
    throw error;
  }
}

/**
 * Export animation using MediaRecorder (fallback)
 */
async function exportAnimationWithMediaRecorder(
  format: VideoFormat,
  quality: VideoQuality,
  progress: ReturnType<typeof useExportProgress.getState>,
  signal: AbortSignal | undefined,
  settings: EncodeSettings
) {
  const bitrate = QUALITY_BITRATES[quality];
  const { mimeType, format: actualFormat } = getMediaRecorderCodec(format);

  const canvas = document.createElement("canvas");
  canvas.style.cssText = "position:fixed;left:-99999px;top:0;pointer-events:none;";
  document.body.appendChild(canvas);

  let stream: MediaStream | null = null;

  try {
    stream = canvas.captureStream(settings.fps);
    const recorder = new MediaRecorder(stream, {
      mimeType,
      videoBitsPerSecond: bitrate,
    });
    const chunks: BlobPart[] = [];

    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    recorder.start();

    let frameCount = 0;
    const frameInterval = 1000 / settings.fps;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("Failed to initialize canvas context for recording");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";

    await streamAnimationToEncoder(
      settings.fps,
      async (sourceCanvas) => {
        if (canvas.width !== sourceCanvas.width || canvas.height !== sourceCanvas.height) {
          canvas.width = sourceCanvas.width;
          canvas.height = sourceCanvas.height;
        }

        ctx.drawImage(sourceCanvas, 0, 0, canvas.width, canvas.height);
        await new Promise((r) => setTimeout(r, Math.min(frameInterval, 16)));

        frameCount++;
        if (frameCount % 10 === 0) {
          await yieldToMain();
        }
      },
      (p) => progress.set(p * 0.95),
      signal
    );

    await new Promise((r) => setTimeout(r, 200));
    recorder.stop();
    await new Promise<void>((resolve) => {
      recorder.onstop = () => resolve();
    });

    const blobType = actualFormat === "mp4" ? "video/mp4" : "video/webm";
    const blob = new Blob(chunks, { type: blobType });
    return finishExport(progress, blob, "animation", actualFormat, settings.fileName, settings.onFile);
  } finally {
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
    }
    canvas.remove();
  }
}
