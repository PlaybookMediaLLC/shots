/**
 * Runs the video compressor on FFmpeg WASM, reusing the editor's loader so the
 * engine downloads once and is cached for both.
 *
 * The source is mounted with WORKERFS, which reads it straight from the File
 * instead of copying it into WASM memory. Only the compressed output lives in
 * FFmpeg's in-memory filesystem.
 */

import type { FFFSType, FFmpeg } from "@ffmpeg/ffmpeg";
import { acquireFFmpegLock, loadFFmpeg, terminateFFmpeg } from "@/lib/export/ffmpeg-encoder";
import {
  INPUT_PATH,
  OUTPUT_FILE,
  PASS_LOG_FILES,
  buildCompressPasses,
  encoderThreads,
  inputFileName,
  parseProbeLog,
  parseProgressTime,
  type CompressSettings,
  type VideoInfo,
} from "./settings";

export type VideoCompressionErrorCode =
  | "engine-unavailable"
  | "no-video-stream"
  | "encode-failed"
  | "aborted";

export class VideoCompressionError extends Error {
  readonly code: VideoCompressionErrorCode;

  constructor(code: VideoCompressionErrorCode, message: string) {
    super(message);
    this.name = "VideoCompressionError";
    this.code = code;
  }
}

export interface CompressResult {
  blob: Blob;
  elapsedMs: number;
}

export interface CompressOptions {
  /** 0-1, from FFmpeg's encoded timestamp against the probed duration. */
  onProgress?: (value: number) => void;
  signal?: AbortSignal;
}

/** Without WORKERFS the whole file is copied into WASM memory, which runs out well before 1 GB. */
const COPY_FALLBACK_MAX_BYTES = 400 * 1024 * 1024;

/** Share of the progress bar for the analysis pass of a two-pass encode; measured at about half the total. */
const FIRST_PASS_SHARE = 0.5;

let activeCancellation: (() => void) | null = null;

/** Keep cancellation local and hold the engine lease until cleanup completes. */
async function withEngine<T>(signal: AbortSignal | undefined, work: (ffmpeg: FFmpeg, check: () => void) => Promise<T>): Promise<T> {
  let cancelled = false;
  let ffmpeg: FFmpeg | undefined;
  const check = () => {
    if (cancelled || signal?.aborted) throw new VideoCompressionError("aborted", "Stopped.");
  };
  const cancel = () => {
    cancelled = true;
    if (ffmpeg) terminateFFmpeg(ffmpeg);
  };
  signal?.addEventListener("abort", cancel, { once: true });
  let release: (() => void) | undefined;
  try {
    check();
    release = await acquireFFmpegLock();
    check();
    activeCancellation = cancel;
    const loaded = await engine();
    // A cancelled startup must not mount a source or terminate another engine owner.
    check();
    ffmpeg = loaded;
    return await work(ffmpeg, check);
  } catch (error) {
    check();
    throw error;
  } finally {
    signal?.removeEventListener("abort", cancel);
    if (activeCancellation === cancel) activeCancellation = null;
    release?.();
  }
}

async function engine(): Promise<FFmpeg> {
  try {
    return await loadFFmpeg();
  } catch {
    throw new VideoCompressionError(
      "engine-unavailable",
      "The video engine could not load. Check your connection and try again.",
    );
  }
}

/** Makes `file` readable inside FFmpeg and returns its path plus a cleanup function. */
async function mountSource(ffmpeg: FFmpeg, file: File, check: () => void): Promise<{ path: string; release: () => Promise<void> }> {
  const name = inputFileName(file.name);
  // Wrapping references the same bytes; it only gives FFmpeg a predictable name.
  const source = new File([file], name, { type: file.type });

  try {
    await ffmpeg.createDir(INPUT_PATH).catch(() => {});
    check();
    // The enum is only a type here: the server build resolves @ffmpeg/ffmpeg to
    // an empty module, so importing its runtime value breaks there.
    await ffmpeg.mount("WORKERFS" as FFFSType, { files: [source] }, INPUT_PATH);
    return {
      path: `${INPUT_PATH}/${name}`,
      release: async () => {
        await ffmpeg.unmount(INPUT_PATH).catch(() => {});
      },
    };
  } catch {
    check();
    if (file.size > COPY_FALLBACK_MAX_BYTES) {
      throw new VideoCompressionError(
        "engine-unavailable",
        "This browser can't stream large files into the video engine. Try a file under 400 MB.",
      );
    }
    const path = `/${name}`;
    const bytes = new Uint8Array(await file.arrayBuffer());
    check();
    await ffmpeg.writeFile(path, bytes);
    return {
      path,
      release: async () => {
        await ffmpeg.deleteFile(path).catch(() => {});
      },
    };
  }
}

/** Reads duration, size, and audio presence by letting FFmpeg describe the file. */
export async function probeVideo(file: File, signal?: AbortSignal): Promise<VideoInfo> {
  return withEngine(signal, async (ffmpeg, check) => {
  const lines: string[] = [];
  const onLog = ({ message }: { message: string }) => lines.push(message);
  const source = await mountSource(ffmpeg, file, check);

  ffmpeg.on("log", onLog);
  try {
    check();
    // With no output FFmpeg prints the stream info and exits non-zero, which is expected.
    await ffmpeg.exec(["-hide_banner", "-i", source.path]);
    check();
  } catch {
    check();
  } finally {
    ffmpeg.off("log", onLog);
    await source.release();
  }

  const info = parseProbeLog(lines);
  if (!info) {
    throw new VideoCompressionError(
      "no-video-stream",
      "We couldn't find a video track in that file. Try an MP4, MOV, WebM, or MKV.",
    );
  }
  return info;
  });
}

export async function compressVideo(
  file: File,
  info: VideoInfo,
  settings: CompressSettings,
  { onProgress, signal }: CompressOptions = {},
): Promise<CompressResult> {
  return withEngine(signal, async (ffmpeg, check) => {
  const startedAt = performance.now();
  const source = await mountSource(ffmpeg, file, check);
  const threads = encoderThreads(navigator.hardwareConcurrency, globalThis.crossOriginIsolated === true);
  const passes = buildCompressPasses(source.path, info, settings, threads);
  const shares = passes.length === 1 ? [1] : [FIRST_PASS_SHARE, 1 - FIRST_PASS_SHARE];
  const tail: string[] = [];
  let progressBase = 0;
  let progressShare = 1;

  const onLog = ({ message }: { message: string }) => {
    tail.push(message);
    if (tail.length > 20) tail.shift();
    if (!onProgress || !info.durationSec) return;
    const seconds = parseProgressTime(message);
    if (seconds !== null) {
      onProgress(progressBase + progressShare * Math.min(1, seconds / info.durationSec));
    }
  };

  let crashed = false;
  ffmpeg.on("log", onLog);
  try {
    for (const [index, args] of passes.entries()) {
      check();
      progressShare = shares[index];
      const exitCode = await ffmpeg.exec(args);
      check();
      if (exitCode !== 0) {
        console.error("FFmpeg failed:\n" + tail.join("\n"));
        throw new VideoCompressionError(
          "encode-failed",
          "Compression failed for this video. Try a lower resolution or a different file.",
        );
      }
      progressBase += progressShare;
    }
    check();
    const data = await ffmpeg.readFile(OUTPUT_FILE);
    check();
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
    onProgress?.(1);
    return { blob: new Blob([bytes], { type: "video/mp4" }), elapsedMs: performance.now() - startedAt };
  } catch (error) {
    check();
    if (error instanceof VideoCompressionError) throw error;
    // A WASM abort (usually memory) leaves the instance unusable, so start fresh next time.
    crashed = true;
    terminateFFmpeg(ffmpeg);
    throw new VideoCompressionError(
      "encode-failed",
      "Compression stopped unexpectedly. Long or high-resolution videos can run out of browser memory, so try a shorter clip or a lower resolution.",
    );
  } finally {
    if (!crashed) {
      ffmpeg.off("log", onLog);
      for (const path of [OUTPUT_FILE, ...PASS_LOG_FILES]) {
        await ffmpeg.deleteFile(path).catch(() => {});
      }
      await source.release();
    }
  }
  });
}

/**
 * FFmpeg WASM cannot interrupt a running command, so stopping terminates the
 * worker. The next run reloads the engine from the browser cache.
 */
export function cancelCompression(): void {
  activeCancellation?.();
}
