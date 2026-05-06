#!/usr/bin/env python3
"""
Transcribe an MP3 file to text using faster-whisper.

Uses the 'medium' model with Dutch (nl) as the forced language — the best
quality/resource trade-off for Dutch on CPU.  The 'small' model is ~4× faster
and uses ~half the RAM if accuracy is less critical.

Usage
-----
  python transcribe.py <audio.mp3> [--model small|medium|large-v3] [--lang nl]

Output
------
  Prints the full transcript to stdout.
  Use --output <file.txt> to write it to a file instead.

Dependencies
------------
  pip install faster-whisper
"""

import argparse
import gc
import sys
from pathlib import Path

MODELS_DIR = Path(__file__).parent / ".models"


def _is_model_cached(model_size: str) -> bool:
    snapshots = MODELS_DIR / f"models--Systran--faster-whisper-{model_size}" / "snapshots"
    if not snapshots.is_dir():
        return False
    return any(
        (snap / "model.bin").exists()  # .exists() follows symlinks
        for snap in snapshots.iterdir()
    )


def transcribe(
    audio_path: Path, model_size: str, lang: str, output: Path | None
) -> None:
    try:
        from faster_whisper import WhisperModel  # type: ignore[import]
    except ImportError:
        sys.exit("faster-whisper is required: pip install faster-whisper")

    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    cached = _is_model_cached(model_size)
    if cached:
        print(f"Using cached model '{model_size}' (offline) …", file=sys.stderr)
    else:
        print(f"Downloading model '{model_size}' to {MODELS_DIR} …", file=sys.stderr)
    model = WhisperModel(
        model_size,
        device="cpu",
        compute_type="int8",
        download_root=str(MODELS_DIR),
        local_files_only=cached,
    )

    print(f"Transcribing {audio_path.name} (lang={lang}) …", file=sys.stderr)
    segments, _info = model.transcribe(str(audio_path), language=lang, beam_size=5)

    lines: list[str] = []
    for seg in segments:
        line = seg.text.strip()
        if line:
            lines.append(line)

    # Release the generator and model explicitly — WhisperModel wraps a
    # ctranslate2 C++ object that won't be freed until its destructor runs.
    # Without this, repeated runs accumulate memory until the VM crashes.
    del segments, model
    gc.collect()

    transcript = "\n".join(lines)

    if output:
        output.write_text(transcript, encoding="utf-8")
        print(f"Transcript written to {output}", file=sys.stderr)
    else:
        print(transcript)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Transcribe an MP3 file to text."
    )
    parser.add_argument("audio", type=Path, help="Path to the MP3 file.")
    parser.add_argument(
        "--model",
        default="small",
        choices=["tiny", "small", "medium", "large-v2", "large-v3"],
        help="Whisper model size (default: small). Use 'small' to halve RAM/time.",
    )
    parser.add_argument(
        "--lang",
        required=True,
        help="BCP-47 language code to force (e.g. nl, en, de).",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=None,
        metavar="FILE",
        help="Write transcript to FILE instead of stdout.",
    )
    args = parser.parse_args()

    if not args.audio.exists():
        sys.exit(f"File not found: {args.audio}")

    transcribe(
        audio_path=args.audio,
        model_size=args.model,
        lang=args.lang,
        output=args.output,
    )


if __name__ == "__main__":
    main()
