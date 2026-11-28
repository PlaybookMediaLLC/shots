#!/usr/bin/env python3
"""Human-quality local-first neural TTS synthesizer for Shots PR video evidence.

Default provider: Kokoro-82M ONNX (`kokoro-onnx`), cached outside the repository
in `~/.cache/shots-pr-evidence/` (override via `PR_VIDEO_EVIDENCE_CACHE_DIR`).
Supports curated natural voices (`af_heart`, `af_bella`, `am_michael`,
`bf_emma`, `bm_george`) and weighted Kokoro voice blends (e.g.
`af_heart:0.75+af_bella:0.25`), sentence-level synthesis with natural breath
pauses, speech-only technical term normalization (without mutating captions),
and two-pass linear loudness mastering (`-16 LUFS`) so voice audio sounds warm,
clear, and genuinely human with zero dynamic gain pumping.

Optional cloud neural fallback: OpenAI TTS (`--provider openai`, requires
explicit `OPENAI_API_KEY` env var, using `gpt-4o-mini-tts` with natural
conversational engineering tone instructions).
"""

from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import math
import os
import re
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
DEFAULT_SPEED = 0.98
MIN_SPEED = 0.5
MAX_SPEED = 2.0
SENTENCE_PAUSE_MS = 240
LEAD_PAD_MS = 90
TRAIL_PAD_MS = 140
FADE_MS = 12
DEFAULT_OPENAI_VOICE = "alloy"
DEFAULT_OPENAI_MODEL = "gpt-4o-mini-tts"
OPENAI_VOICE_INSTRUCTIONS = (
    "Speak naturally like a calm, experienced senior software engineer walking "
    "a teammate through a pull request demo. Use conversational phrasing, "
    "natural breathing and subtle pauses between sentences, warm neutral "
    "intonation, and clear enunciation without sounding promotional or robotic."
)
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
SENTENCE_SPLIT_RE = re.compile(
    r"(?<!\be\.g\.)(?<!\bi\.e\.)(?<!\bvs\.)(?<!\betc\.)(?<!\bNo\.)"
    r"(?<!\bDr\.)(?<!\bMr\.)(?<!\bMrs\.)(?<!\bMs\.)(?<!\bSt\.)"
    r"(?<=[.!?])\s+(?=[A-Z0-9\"'(])"
)
ORDINAL_FRAGMENT_RE = re.compile(r"^\d+[.)]$")
SPEAKABLE_RE = re.compile(r"[A-Za-z0-9]")

# Spoken-only technical term normalization: keeps captions/transcript exact
# while preventing awkward letter-by-letter or mispronounced phonemization.
SPEECH_REPLACEMENTS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"\b1920\s*[x×]\s*1080\b", re.IGNORECASE), "1080p"),
    (re.compile(r"\bSHA-(1|256|384|512)\b", re.IGNORECASE), r"S H A \1"),
    (re.compile(r"\bcommit\s+SHAs\b(?!-|\s+hash(?:es)?\b)", re.IGNORECASE), "commit hashes"),
    (re.compile(r"\bcommit\s+SHA\b(?!-|\s+hash\b)", re.IGNORECASE), "commit hash"),
    (re.compile(r"\bSHAs\b(?!-|\s+hash(?:es)?\b)"), "hashes"),
    (re.compile(r"\bSHA\b(?!-|\s+hash\b)"), "hash"),
    (re.compile(r"\bHTTP\s+401\b", re.IGNORECASE), "HTTP four oh one"),
    (re.compile(r"\bHTTP\s+403\b", re.IGNORECASE), "HTTP four oh three"),
    (re.compile(r"\bHTTP\s+404\b", re.IGNORECASE), "HTTP four oh four"),
    (re.compile(r"\bHTTP\s+200\b", re.IGNORECASE), "HTTP two hundred"),
    (re.compile(r"\bHTTP\s+500\b", re.IGNORECASE), "HTTP five hundred"),
    (re.compile(r"\btRPC\b"), "T R P C"),
    (re.compile(r"\bOAuth\b"), "oh-auth"),
    (re.compile(r"\bNext\.js\b", re.IGNORECASE), "Next J S"),
    (re.compile(r"\bFFmpeg\b", re.IGNORECASE), "F F mpeg"),
    (re.compile(r"\bFFprobe\b", re.IGNORECASE), "F F probe"),
    (re.compile(r"\bJSON\b"), "jay-son"),
    (re.compile(r"\bSQL\b"), "sequel"),
    (re.compile(r"\bCLI\b"), "C L I"),
    (re.compile(r"\bPRs\b"), "pull requests"),
    (re.compile(r"\bPR\b"), "pull request"),
    (re.compile(r"\bUI\b"), "U I"),
    (re.compile(r"\bCI\b"), "C I"),
    (re.compile(r"\bAPI\b"), "A P I"),
    (re.compile(r"\bURL\b"), "U R L"),
    (re.compile(r"\bMP4\b"), "M P 4"),
    (re.compile(r"\bPNG\b"), "P N G"),
    (re.compile(r"\bAAC\b"), "A A C"),
    (re.compile(r"\bH\.264\b", re.IGNORECASE), "H 2 64"),
]


def normalize_for_speech(text: str) -> str:
    """Make technical prose read smoothly aloud while leaving captions untouched."""
    spoken = " ".join(text.strip().split())
    for pattern, replacement in SPEECH_REPLACEMENTS:
        spoken = pattern.sub(replacement, spoken)
    return spoken


def split_sentences(text: str) -> list[str]:
    """Split multi-sentence narration into natural phrasing units without
    isolating abbreviations, numbered list markers, or punctuation-only fragments."""
    cleaned = text.strip()
    if not cleaned:
        return []
    raw_parts = [s.strip() for s in SENTENCE_SPLIT_RE.split(cleaned) if s.strip()]
    if not raw_parts:
        return [cleaned]

    merged: list[str] = []
    i = 0
    while i < len(raw_parts):
        part = raw_parts[i]
        # Merge standalone ordinal markers like "1." into the following sentence.
        if ORDINAL_FRAGMENT_RE.match(part) and i + 1 < len(raw_parts):
            merged.append(f"{part} {raw_parts[i + 1]}")
            i += 2
            continue
        # Merge punctuation-only fragments back into the previous sentence.
        if not SPEAKABLE_RE.search(part):
            if merged:
                merged[-1] = f"{merged[-1]} {part}"
            elif i + 1 < len(raw_parts):
                raw_parts[i + 1] = f"{part} {raw_parts[i + 1]}"
            else:
                merged.append(part)
            i += 1
            continue
        merged.append(part)
        i += 1
    return merged


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
        if not text or not SPEAKABLE_RE.search(text):
            raise RuntimeError(f"Cue '{cue_id}' has empty or non-speakable narration text.")
        if cue_id in seen_ids:
            raise RuntimeError(f"Duplicate cue id '{cue_id}'.")
        seen_ids.add(cue_id)
        base_stem = safe_stem(cue_id, idx)
        stem = base_stem
        suffix = idx + 1
        while stem in seen_stems:
            stem = f"{base_stem}-{suffix:02d}"
            suffix += 1
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


def parse_loudnorm_stats(stderr: str) -> dict[str, float] | None:
    """Safely parse and bounds-check the last FFmpeg loudnorm JSON block.

    Returns None when measurements are missing, malformed, non-finite (e.g.
    '-inf' on <400ms clips), or outside FFmpeg loudnorm parameter bounds.
    """
    matches = re.findall(r"\{[^{}]*\"input_i\"[^{}]*\}", stderr, re.DOTALL)
    if not matches:
        return None
    try:
        raw = json.loads(matches[-1])
        measured_i = float(raw["input_i"])
        measured_tp = float(raw["input_tp"])
        measured_lra = float(raw["input_lra"])
        measured_thresh = float(raw["input_thresh"])
        offset = float(raw["target_offset"])
    except (ValueError, TypeError, KeyError):
        return None

    values = (measured_i, measured_tp, measured_lra, measured_thresh, offset)
    if not all(math.isfinite(v) for v in values):
        return None
    if not (
        -99.0 <= measured_i <= 0.0
        and -99.0 <= measured_tp <= 99.0
        and 0.0 <= measured_lra <= 99.0
        and -99.0 <= measured_thresh <= 0.0
        and -99.0 <= offset <= 99.0
    ):
        return None
    return {
        "input_i": measured_i,
        "input_tp": measured_tp,
        "input_lra": measured_lra,
        "input_thresh": measured_thresh,
        "target_offset": offset,
    }


def normalize_to_wav(src: Path, dest: Path) -> float:
    """Master speech to 48kHz mono PCM WAV using two-pass linear loudnorm.

    Avoids single-pass dynamic loudnorm pumping on short voice clips while
    hitting broadcast-consistent -16 LUFS loudness and clean rumble roll-off.
    Resamples to 48kHz before alimiter so limiting runs at 48kHz rather than
    loudnorm's internal 192kHz rate.
    """
    tmp = dest.with_suffix(".norm.wav")
    fallback_filter = "highpass=f=75,aresample=48000,alimiter=limit=0.92:attack=5:release=50"
    try:
        # Pass 1: measure true integrated loudness of the speech segment.
        try:
            probe = subprocess.run(
                [
                    "ffmpeg",
                    "-hide_banner",
                    "-nostats",
                    "-threads",
                    "1",
                    "-filter_threads",
                    "1",
                    "-i",
                    str(src),
                    "-vn",
                    "-sn",
                    "-dn",
                    "-af",
                    "highpass=f=75,loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json",
                    "-f",
                    "null",
                    "-",
                ],
                check=True,
                capture_output=True,
                text=True,
            )
        except subprocess.CalledProcessError as err:
            detail = (err.stderr or "").strip()[-400:]
            raise RuntimeError(f"FFmpeg loudnorm pass 1 failed for {src.name}: {detail}") from err

        stats = parse_loudnorm_stats(probe.stderr or "")
        if stats is not None:
            loud_filter = (
                f"highpass=f=75,"
                f"loudnorm=I=-16:TP=-1.5:LRA=11:linear=true:"
                f"measured_I={stats['input_i']:.2f}:"
                f"measured_TP={stats['input_tp']:.2f}:"
                f"measured_LRA={stats['input_lra']:.2f}:"
                f"measured_thresh={stats['input_thresh']:.2f}:"
                f"offset={stats['target_offset']:.2f},"
                f"aresample=48000,"
                f"alimiter=limit=0.92:attack=5:release=50"
            )
        else:
            loud_filter = fallback_filter

        # Pass 2: apply constant linear gain for natural, unpumped human tone.
        try:
            subprocess.run(
                [
                    "ffmpeg",
                    "-y",
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-threads",
                    "1",
                    "-filter_threads",
                    "1",
                    "-i",
                    str(src),
                    "-ar",
                    "48000",
                    "-ac",
                    "1",
                    "-af",
                    loud_filter,
                    "-c:a",
                    "pcm_s16le",
                    str(tmp),
                ],
                check=True,
                capture_output=True,
                text=True,
            )
        except subprocess.CalledProcessError as err:
            detail = (err.stderr or "").strip()[-400:]
            raise RuntimeError(f"FFmpeg loudnorm pass 2 failed for {src.name}: {detail}") from err

        dur = measure_wav_duration(tmp)
        if dur <= 0.05:
            raise RuntimeError(f"Synthesized audio {dest} is empty ({dur:.3f}s).")
        tmp.replace(dest)
        return dur
    finally:
        tmp.unlink(missing_ok=True)


def infer_kokoro_lang(voice_spec: str) -> str:
    """Select en-gb when all voices in a single or blended spec are British."""
    names = [p.split(":", 1)[0].strip() for p in voice_spec.split("+") if p.strip()]
    if names and all(name.startswith(("bf_", "bm_")) for name in names):
        return "en-gb"
    return "en-us"


def resolve_kokoro_voice(kokoro: object, voice_spec: str) -> object:
    """Support either a single Kokoro voice or a weighted blend (`a:0.7+b:0.3`)."""
    spec = voice_spec.strip()
    if not spec:
        raise RuntimeError("Kokoro voice specification must be non-empty.")
    if "+" not in spec:
        return spec

    parts = [p.strip() for p in spec.split("+") if p.strip()]
    if not parts:
        raise RuntimeError(f"Invalid Kokoro voice blend '{voice_spec}'.")
    weighted_names: list[tuple[str, float]] = []
    total_weight = 0.0
    for part in parts:
        if ":" in part:
            name_raw, weight_str = part.split(":", 1)
            try:
                weight = float(weight_str.strip())
            except ValueError as err:
                raise RuntimeError(
                    f"Invalid weight '{weight_str}' in Kokoro voice blend '{voice_spec}'."
                ) from err
        else:
            name_raw, weight = part, 1.0
        name = name_raw.strip()
        if not name:
            raise RuntimeError(f"Empty voice name in Kokoro voice blend '{voice_spec}'.")
        if not math.isfinite(weight) or weight <= 0.0:
            raise RuntimeError(
                f"Voice blend weights must be finite positive numbers (got {weight} in '{voice_spec}')."
            )
        weighted_names.append((name, weight))
        total_weight += weight
    if not weighted_names or not math.isfinite(total_weight) or total_weight <= 0.0:
        raise RuntimeError(f"Invalid Kokoro voice blend '{voice_spec}'.")

    import numpy as np  # type: ignore[import-not-found]

    blended = None
    for name, weight in weighted_names:
        style = kokoro.get_voice_style(name)  # type: ignore[attr-defined]
        blended = style * weight if blended is None else blended + style * weight
    return np.asarray(blended / total_weight, dtype=np.float32)


def apply_edge_fade(samples: object, sample_rate: int, fade_ms: int = FADE_MS) -> object:
    """Apply a tiny cosine fade-in/out to prevent clicks between stitched sentences."""
    import numpy as np  # type: ignore[import-not-found]

    arr = np.asarray(samples, dtype=np.float32).copy()
    n_fade = min(int(sample_rate * fade_ms / 1000), len(arr) // 4)
    if n_fade > 1:
        ramp = 0.5 * (1.0 - np.cos(np.linspace(0.0, np.pi, n_fade, dtype=np.float32)))
        arr[:n_fade] *= ramp
        arr[-n_fade:] *= ramp[::-1]
    return arr


def synthesize_kokoro(
    cues: list[tuple[str, str, str]], out_dir: Path, voice: str, speed: float
) -> tuple[str, str, list[dict[str, object]]]:
    try:
        import numpy as np  # type: ignore[import-not-found]
        import soundfile as sf  # type: ignore[import-not-found]
        from kokoro_onnx import Kokoro  # type: ignore[import-not-found]

        model_path, voices_path = ensure_kokoro_models()
        kokoro = Kokoro(str(model_path), str(voices_path))
    except Exception as err:
        raise RuntimeError(
            f"Human-quality Kokoro ONNX TTS could not initialize ({err}). Run "
            "`node dev/pr-video-evidence/cli.mjs setup-kokoro` or pass "
            "`--tts openai` (or `tts.py --provider openai`) with OPENAI_API_KEY."
        ) from err

    voice_input = resolve_kokoro_voice(kokoro, voice)
    lang = infer_kokoro_lang(voice)

    # Overlap single-threaded two-pass FFmpeg mastering (at most 2 workers so
    # ONNX inference is not CPU-starved) and fail fast if an earlier cue fails.
    futures = []
    with ThreadPoolExecutor(max_workers=min(2, len(cues))) as pool:
        try:
            for cue_id, stem, text in cues:
                for done_fut in futures:
                    if done_fut.done():
                        done_fut.result()

                raw_wav = out_dir / f"{stem}.raw.wav"
                final_wav = out_dir / f"{stem}.wav"
                spoken_sentences = split_sentences(normalize_for_speech(text))
                chunks: list[object] = []
                sr = 24000
                speech_samples = 0
                peak_amp = 0.0
                for idx_s, sentence in enumerate(spoken_sentences):
                    samples, sample_rate = kokoro.create(
                        sentence, voice=voice_input, speed=speed, lang=lang
                    )
                    sr = int(sample_rate)
                    faded = apply_edge_fade(samples, sr)
                    arr = np.asarray(faded, dtype=np.float32)
                    if len(arr) > 0:
                        speech_samples += len(arr)
                        peak_amp = max(peak_amp, float(np.max(np.abs(arr))))
                        chunks.append(arr)
                    if idx_s < len(spoken_sentences) - 1:
                        chunks.append(
                            np.zeros(int(sr * SENTENCE_PAUSE_MS / 1000), dtype=np.float32)
                        )
                if speech_samples / float(sr) <= 0.05 or peak_amp < 1e-4:
                    raise RuntimeError(
                        f"Kokoro synthesized empty or silent speech for cue '{cue_id}'."
                    )
                lead = np.zeros(int(sr * LEAD_PAD_MS / 1000), dtype=np.float32)
                trail = np.zeros(int(sr * TRAIL_PAD_MS / 1000), dtype=np.float32)
                combined = np.concatenate([lead, *chunks, trail])
                sf.write(str(raw_wav), combined, sr)

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
        except Exception:
            for fut in futures:
                fut.cancel()
            raise
    return "kokoro-onnx", voice.strip(), results


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
            render_raw(normalize_for_speech(text), raw_wav)
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
    pool = ThreadPoolExecutor(max_workers=workers)
    futures = [pool.submit(worker, item) for item in cues]
    try:
        results = [fut.result() for fut in futures]
        pool.shutdown(wait=True)
        return results
    except Exception:
        pool.shutdown(wait=True, cancel_futures=True)
        raise


def synthesize_openai(
    cues: list[tuple[str, str, str]], out_dir: Path, voice: str, speed: float
) -> tuple[str, str, list[dict[str, object]]]:
    api_key = os.environ.get("OPENAI_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError(
            "OPENAI_API_KEY is required when using --provider openai."
        )
    model = (
        os.environ.get("PR_VIDEO_EVIDENCE_OPENAI_TTS_MODEL", "").strip()
        or DEFAULT_OPENAI_MODEL
    )
    openai_voice = voice if voice in VALID_OPENAI_VOICES else DEFAULT_OPENAI_VOICE

    def render_raw(text: str, raw_wav: Path) -> None:
        body: dict[str, object] = {
            "model": model,
            "input": text,
            "voice": openai_voice,
            "response_format": "wav",
            "speed": speed,
        }
        if model.startswith("gpt-4o"):
            body["instructions"] = OPENAI_VOICE_INSTRUCTIONS
        payload = json.dumps(body).encode("utf-8")
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
    parser = argparse.ArgumentParser(
        description="Synthesize human-quality neural PR video narration cues."
    )
    parser.add_argument("--cues", help="Path to JSON file containing cues.")
    parser.add_argument(
        "--out-dir", help="Output directory for WAV files and segments.json."
    )
    parser.add_argument(
        "--provider",
        choices=["kokoro", "openai"],
        default="kokoro",
        help="Human-quality neural TTS provider (default: kokoro).",
    )
    parser.add_argument(
        "--voice",
        default=DEFAULT_KOKORO_VOICE,
        help=f"Voice identifier or Kokoro blend e.g. af_heart:0.75+af_bella:0.25 (default: {DEFAULT_KOKORO_VOICE}).",
    )
    parser.add_argument(
        "--speed",
        type=float,
        default=DEFAULT_SPEED,
        help=f"Speech rate multiplier between {MIN_SPEED} and {MAX_SPEED} (default: {DEFAULT_SPEED}).",
    )
    parser.add_argument(
        "--setup-only",
        action="store_true",
        help="Download and verify Kokoro ONNX model files without synthesizing.",
    )
    args = parser.parse_args()

    if not math.isfinite(args.speed) or not (MIN_SPEED <= args.speed <= MAX_SPEED):
        parser.error(
            f"--speed must be a finite number between {MIN_SPEED} and {MAX_SPEED} (got {args.speed})."
        )

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

    if args.provider == "kokoro":
        provider_used, voice_used, segments = synthesize_kokoro(
            cues, out_dir, args.voice, args.speed
        )
    else:
        provider_used, voice_used, segments = synthesize_openai(
            cues, out_dir, args.voice, args.speed
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
