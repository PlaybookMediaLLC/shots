#!/usr/bin/env python3
"""Local-first TTS synthesizer for Shots PR video evidence.

Default provider: Kokoro ONNX (`kokoro-onnx`), cached outside the repository
in `~/.cache/shots-pr-evidence/` (override via `PR_VIDEO_EVIDENCE_CACHE_DIR`).
Optional cloud fallback: OpenAI TTS (`--provider openai`, requires explicit
`OPENAI_API_KEY` env var).
Offline fallback: `espeak-ng` (`--provider espeak-ng`, or automatic fallback
when `--allow-fallback` is set and Kokoro cannot run).

Input: JSON file with list of `{ "id": "...", "text": "..." }` cues.
Output: Individual WAV files + `segments.json` with exact measured durations.
"""

from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from typing import Callable
import urllib.request
import wave
from pathlib import Path

KOKORO_RELEASE_BASE = (
    "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0"
)
KOKORO_MODEL_FILE = "kokoro-v1.0.onnx"
KOKORO_MODEL_SHA256 = (
    "7d5df8ecf7d4b1878015a32686053fd0eebe2bc377234608764cc0ef3636a6c5"
)
KOKORO_VOICES_FILE = "voices-v1.0.bin"
KOKORO_VOICES_SHA256 = (
    "bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d"
)
DEFAULT_KOKORO_VOICE = "af_heart"
DEFAULT_OPENAI_VOICE = "alloy"
DEFAULT_OPENAI_MODEL = "gpt-4o-mini-tts"
VALID_OPENAI_VOICES = {
    "alloy",
    "ash",
    "coral",
    "echo",
    "fable",
    "onyx",
    "nova",
    "sage",
    "shimmer",
}
SAFE_STEM_RE = re.compile(r"[^A-Za-z0-9._-]+")


def cache_dir() -> Path:
    override = os.environ.get("PR_VIDEO_EVIDENCE_CACHE_DIR")
    if override:
        return Path(override).expanduser()
    return Path.home() / ".cache" / "shots-pr-evidence"


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def ensure_file(url: str, dest: Path, min_bytes: int, expected_sha256: str) -> None:
    if dest.exists() and dest.stat().st_size >= min_bytes:
        if sha256_file(dest) == expected_sha256:
            return
        sys.stderr.write(
            f"[tts] Checksum mismatch on cached {dest.name}; re-downloading.\n"
        )
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            dir=dest.parent, prefix=f".{dest.name}.", suffix=".part", delete=False
        ) as tmp_fh:
            tmp_path = Path(tmp_fh.name)
            sys.stderr.write(f"[tts] Downloading {dest.name} from {url}...\n")
            digest = hashlib.sha256()
            size = 0
            with urllib.request.urlopen(url, timeout=120) as resp:
                while True:
                    chunk = resp.read(1024 * 1024)
                    if not chunk:
                        break
                    tmp_fh.write(chunk)
                    digest.update(chunk)
                    size += len(chunk)
        if size < min_bytes:
            raise RuntimeError(
                f"Downloaded {dest.name} was unexpectedly small ({size} bytes < {min_bytes})."
            )
        actual_sha = digest.hexdigest()
        if actual_sha != expected_sha256:
            raise RuntimeError(
                f"SHA-256 mismatch for {dest.name}: expected {expected_sha256}, got {actual_sha}."
            )
        tmp_path.replace(dest)
        tmp_path = None
    finally:
        if tmp_path is not None:
            tmp_path.unlink(missing_ok=True)


def ensure_kokoro_models() -> tuple[Path, Path]:
    models_dir = cache_dir() / "models"
    model_path = models_dir / KOKORO_MODEL_FILE
    voices_path = models_dir / KOKORO_VOICES_FILE
    ensure_file(
        f"{KOKORO_RELEASE_BASE}/{KOKORO_MODEL_FILE}",
        model_path,
        50_000_000,
        KOKORO_MODEL_SHA256,
    )
    ensure_file(
        f"{KOKORO_RELEASE_BASE}/{KOKORO_VOICES_FILE}",
        voices_path,
        1_000_000,
        KOKORO_VOICES_SHA256,
    )
    return model_path, voices_path


def safe_stem(cue_id: str, idx: int) -> str:
    cleaned = SAFE_STEM_RE.sub("_", cue_id).strip("._")
    if not cleaned or ".." in cleaned:
        return f"cue-{idx + 1:02d}"
    return cleaned


def validate_cues(raw_cues: object) -> list[tuple[str, str, str]]:
    if not isinstance(raw_cues, list) or len(raw_cues) == 0:
        raise RuntimeError("Cues JSON must be a non-empty array.")
    seen_ids: set[str] = set()
    seen_stems: set[str] = set()
    validated: list[tuple[str, str, str]] = []
    for idx, cue in enumerate(raw_cues):
        if not isinstance(cue, dict):
            raise RuntimeError(f"Cue at index {idx} must be an object.")
        cue_id = str(cue.get("id") or f"cue-{idx + 1:02d}").strip()
        text = str(cue.get("text") or "").strip()
        if not text:
            raise RuntimeError(f"Cue '{cue_id}' has empty narration text.")
        if cue_id in seen_ids:
            raise RuntimeError(f"Duplicate cue id '{cue_id}'.")
        seen_ids.add(cue_id)
        stem = safe_stem(cue_id, idx)
        if stem in seen_stems:
            stem = f"{stem}-{idx + 1:02d}"
        seen_stems.add(stem)
        validated.append((cue_id, stem, text))
    return validated


def measure_wav_duration(path: Path) -> float:
    with wave.open(str(path), "rb") as wf:
        frames = wf.getnframes()
        rate = wf.getframerate()
        if rate <= 0:
            raise RuntimeError(f"Invalid sample rate in {path}")
        return frames / float(rate)


def normalize_to_wav(src: Path, dest: Path) -> float:
    """Convert audio to 48kHz mono PCM WAV with loudness leveling before atomic rename."""
    tmp = dest.with_suffix(".norm.wav")
    try:
        cmd = [
            "ffmpeg",
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            str(src),
            "-ar",
            "48000",
            "-ac",
            "1",
            "-af",
            "loudnorm=I=-16:TP=-1.5:LRA=11",
            "-c:a",
            "pcm_s16le",
            str(tmp),
        ]
        subprocess.run(cmd, check=True)
        dur = measure_wav_duration(tmp)
        if dur <= 0.05:
            raise RuntimeError(f"Synthesized audio {dest} is empty ({dur:.3f}s).")
        tmp.replace(dest)
        return dur
    finally:
        tmp.unlink(missing_ok=True)


def run_parallel_cues(
    cues: list[tuple[str, str, str]],
    out_dir: Path,
    render_raw: Callable[[str, Path], None],
    max_workers: int = 4,
) -> list[dict[str, object]]:
    def worker(item: tuple[str, str, str]) -> dict[str, object]:
        cue_id, stem, text = item
        raw_wav = out_dir / f"{stem}.raw.wav"
        final_wav = out_dir / f"{stem}.wav"
        try:
            render_raw(text, raw_wav)
            duration = normalize_to_wav(raw_wav, final_wav)
        finally:
            raw_wav.unlink(missing_ok=True)
        return {
            "id": cue_id,
            "text": text,
            "audioPath": str(final_wav),
            "durationSeconds": round(duration, 4),
        }

    workers = max(1, min(max_workers, len(cues)))
    if workers == 1:
        return [worker(item) for item in cues]
    with ThreadPoolExecutor(max_workers=workers) as pool:
        return list(pool.map(worker, cues))


def synthesize_kokoro(
    cues: list[tuple[str, str, str]], out_dir: Path, voice: str, speed: float
) -> tuple[str, str, list[dict[str, object]]]:
    import soundfile as sf  # type: ignore[import-not-found]
    from kokoro_onnx import Kokoro  # type: ignore[import-not-found]

    model_path, voices_path = ensure_kokoro_models()
    kokoro = Kokoro(str(model_path), str(voices_path))

    # Overlap FFmpeg loudness normalization with Kokoro ONNX inference while
    # preserving deterministic cue order.
    futures = []
    with ThreadPoolExecutor(max_workers=min(4, len(cues))) as pool:
        for cue_id, stem, text in cues:
            raw_wav = out_dir / f"{stem}.raw.wav"
            final_wav = out_dir / f"{stem}.wav"
            samples, sample_rate = kokoro.create(
                text, voice=voice, speed=speed, lang="en-us"
            )
            sf.write(str(raw_wav), samples, sample_rate)

            def finalize(
                cid: str = cue_id,
                txt: str = text,
                raw: Path = raw_wav,
                final: Path = final_wav,
            ) -> dict[str, object]:
                try:
                    duration = normalize_to_wav(raw, final)
                finally:
                    raw.unlink(missing_ok=True)
                return {
                    "id": cid,
                    "text": txt,
                    "audioPath": str(final),
                    "durationSeconds": round(duration, 4),
                }

            futures.append(pool.submit(finalize))
        results = [fut.result() for fut in futures]
    return "kokoro-onnx", voice, results


def synthesize_espeak(
    cues: list[tuple[str, str, str]], out_dir: Path, speed: float
) -> tuple[str, str, list[dict[str, object]]]:
    if not shutil.which("espeak-ng"):
        raise RuntimeError("espeak-ng is not installed.")
    wpm = max(120, min(220, int(round(165 * speed))))

    def render_raw(text: str, raw_wav: Path) -> None:
        subprocess.run(
            ["espeak-ng", "-v", "en-us", "-s", str(wpm), "-w", str(raw_wav), "--", text],
            check=True,
        )

    results = run_parallel_cues(cues, out_dir, render_raw, max_workers=4)
    return "espeak-ng", "en-us", results


def synthesize_openai(
    cues: list[tuple[str, str, str]], out_dir: Path, voice: str, speed: float
) -> tuple[str, str, list[dict[str, object]]]:
    api_key = os.environ.get("OPENAI_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError(
            "OPENAI_API_KEY is required when using --provider openai."
        )
    model = os.environ.get("PR_VIDEO_EVIDENCE_OPENAI_TTS_MODEL", DEFAULT_OPENAI_MODEL)
    openai_voice = voice if voice in VALID_OPENAI_VOICES else DEFAULT_OPENAI_VOICE

    def render_raw(text: str, raw_wav: Path) -> None:
        payload = json.dumps(
            {
                "model": model,
                "input": text,
                "voice": openai_voice,
                "response_format": "wav",
                "speed": speed,
            }
        ).encode("utf-8")
        req = urllib.request.Request(
            "https://api.openai.com/v1/audio/speech",
            data=payload,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=60) as resp:
            raw_wav.write_bytes(resp.read())

    results = run_parallel_cues(cues, out_dir, render_raw, max_workers=4)
    return f"openai-tts:{model}", openai_voice, results


def main() -> int:
    parser = argparse.ArgumentParser(description="Synthesize PR video narration cues.")
    parser.add_argument("--cues", help="Path to JSON file containing cues.")
    parser.add_argument("--out-dir", help="Output directory for WAV files and segments.json.")
    parser.add_argument(
        "--provider",
        choices=["kokoro", "openai", "espeak-ng"],
        default="kokoro",
        help="TTS provider (default: kokoro).",
    )
    parser.add_argument(
        "--voice",
        default=DEFAULT_KOKORO_VOICE,
        help=f"Voice identifier (default: {DEFAULT_KOKORO_VOICE}).",
    )
    parser.add_argument(
        "--speed",
        type=float,
        default=1.05,
        help="Speech rate multiplier (default: 1.05).",
    )
    parser.add_argument(
        "--allow-fallback",
        action="store_true",
        help="Fall back to espeak-ng if Kokoro cannot initialize.",
    )
    parser.add_argument(
        "--setup-only",
        action="store_true",
        help="Download and verify Kokoro ONNX model files without synthesizing.",
    )
    args = parser.parse_args()

    if args.setup_only:
        model_path, voices_path = ensure_kokoro_models()
        print(
            json.dumps(
                {
                    "ok": True,
                    "provider": "kokoro-onnx",
                    "modelPath": str(model_path),
                    "voicesPath": str(voices_path),
                }
            )
        )
        return 0

    if not args.cues or not args.out_dir:
        parser.error("--cues and --out-dir are required unless --setup-only is set.")

    cues_path = Path(args.cues)
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    cues = validate_cues(json.loads(cues_path.read_text(encoding="utf-8")))

    provider_used: str
    voice_used: str
    segments: list[dict[str, object]]

    if args.provider == "kokoro":
        try:
            provider_used, voice_used, segments = synthesize_kokoro(
                cues, out_dir, args.voice, args.speed
            )
        except Exception as err:
            if not args.allow_fallback:
                raise
            sys.stderr.write(
                f"[tts] Kokoro unavailable ({err}); falling back to espeak-ng.\n"
            )
            provider_used, voice_used, segments = synthesize_espeak(
                cues, out_dir, args.speed
            )
    elif args.provider == "openai":
        provider_used, voice_used, segments = synthesize_openai(
            cues, out_dir, args.voice, args.speed
        )
    else:
        provider_used, voice_used, segments = synthesize_espeak(
            cues, out_dir, args.speed
        )

    manifest = {
        "provider": provider_used,
        "voice": voice_used,
        "speed": args.speed,
        "segments": segments,
    }
    (out_dir / "segments.json").write_text(
        json.dumps(manifest, indent=2) + "\n", encoding="utf-8"
    )
    print(json.dumps(manifest))
    return 0


if __name__ == "__main__":
    sys.exit(main())
