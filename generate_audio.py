#!/usr/bin/env python3
"""
LingoPlayer – Piper TTS audio pre-generator
============================================

Walks every user folder in S3, reads each deck's CSV, and synthesizes
WAV audio for any word or example sentence that hasn't been done yet.
Re-runs are cheap: already-processed cells are tracked in a per-user
manifest keyed by a 32-bit FNV-1a hash so only new/changed content is
synthesized.

The same hash MUST be reproduced on the frontend to look up audio by
content.  Copy this snippet into your JS/TS app:

    // cellHash(lang: string, text: string): string
    function cellHash(lang, text) {
      const bytes = new TextEncoder().encode(`${lang}:${text}`);
      let h = 2166136261;          // FNV-32 offset basis
      for (const b of bytes) {
        h ^= b;
        h = Math.imul(h, 16777619) >>> 0;  // FNV-32 prime, keep 32-bit
      }
      return h.toString(16).padStart(8, '0');
    }

    // Audio key for a given hash:
    // users/{safeEmail}/audio/{hash}.wav

S3 layout added by this script
-------------------------------
  users/{email}/
    audio/
      {hash}.wav          one file per unique (lang, text) pair
    audio-manifest.json   { "{hash}": true, ... }  – the processed-cell index

Usage
-----
  python generate_audio.py [--dry-run] [--user EMAIL] [--workers N]

  --dry-run     list what would be generated without running piper or uploading
  --user EMAIL  process only one user (exact safeEmail folder name)
  --workers N   parallel synthesis workers (default: CPU count)

Environment variables  (same as the Next.js app)
------------------------------------------------
  Required:
    S3_BUCKET
    S3_ACCESS_KEY_ID
    S3_SECRET_ACCESS_KEY

  Optional:
    S3_REGION          default: eu-central-1
    S3_PATH_PREFIX     default: users

    PIPER_BIN          path to piper binary            default: piper
    PIPER_MODELS_DIR   directory containing .onnx files default: ./models

Model files
-----------
  Download from https://huggingface.co/rhasspy/piper-voices
  Place the .onnx and its companion .onnx.json in PIPER_MODELS_DIR.
  Example:
    models/
      nl_NL-mls-medium.onnx
      nl_NL-mls-medium.onnx.json
      en_US-lessac-medium.onnx
      en_US-lessac-medium.onnx.json
      ...

Dependencies
------------
  pip install boto3 python-dotenv
"""

import argparse
import csv
import io
import json
import os
import subprocess
import sys
import tempfile
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

try:
    from dotenv import load_dotenv
except ImportError:
    sys.exit("python-dotenv is required: pip install python-dotenv")

try:
    import boto3
    from botocore.exceptions import ClientError
except ImportError:
    sys.exit("boto3 is required: pip install boto3")

# Load .env.local first (Next.js convention), then .env as fallback.
# Both are resolved relative to this script's directory.
_script_dir = Path(__file__).parent
for _env_file in (".env.local", ".env"):
    _path = _script_dir / _env_file
    if _path.exists():
        load_dotenv(_path, override=False)
        print(f"Loaded env from {_path}")
        break

# ── Configuration ─────────────────────────────────────────────────────────────

def _require(name: str) -> str:
    v = os.environ.get(name)
    if not v:
        sys.exit(f"Missing required environment variable: {name}")
    return v

S3_BUCKET        = _require("S3_BUCKET")
S3_REGION        = os.environ.get("S3_REGION", "eu-central-1")
S3_ACCESS_KEY_ID = _require("S3_ACCESS_KEY_ID")
S3_SECRET_KEY    = _require("S3_SECRET_ACCESS_KEY")
S3_PREFIX        = os.environ.get("S3_PATH_PREFIX", "users").rstrip("/")

PIPER_BIN    = os.environ.get("PIPER_BIN", "piper")
MODELS_DIR   = Path(os.environ.get("PIPER_MODELS_DIR", "./.models"))

# language code → Piper voice model stem (filename without .onnx)
# Download from https://huggingface.co/rhasspy/piper-voices
# cspell:disable
LANGUAGE_MODELS: dict[str, str] = {
    "nl": "nl_NL-ronnie-medium",
    "en": "en_US-lessac-medium",
    "es": "es_ES-mls-medium",
    "fr": "fr_FR-mls-medium",
    "de": "de_DE-thorsten-medium",
    "it": "it_IT-riccardo-x_low",
    "pt": "pt_BR-faber-medium",
    "ja": "ja_JP-kokoro-medium",
    "ko": "ko_KR-neon-medium",
    "zh": "zh_CN-huayan-x_low",
}
# cspell:enable

AUDIO_SUBDIR  = "audio"
MANIFEST_FILE = "audio-manifest.json"

# ── S3 client ─────────────────────────────────────────────────────────────────

# boto3 S3 clients are thread-safe; one shared client is fine for all threads.
s3 = boto3.client(
    "s3",
    region_name=S3_REGION,
    aws_access_key_id=S3_ACCESS_KEY_ID,
    aws_secret_access_key=S3_SECRET_KEY,
)

# ── FNV-1a 32-bit hash ────────────────────────────────────────────────────────
#
# Input:  f"{lang}:{text}"  encoded as UTF-8
# Output: lowercase 8-char hex string
#
# Must stay byte-for-byte identical to the JS snippet in the module docstring.

def cell_hash(lang: str, text: str) -> str:
    h = 2166136261          # FNV-32 offset basis
    for b in f"{lang}:{text}".encode("utf-8"):
        h ^= b
        h = (h * 16777619) & 0xFFFFFFFF   # FNV-32 prime, keep 32-bit
    return f"{h:08x}"

# ── S3 helpers ────────────────────────────────────────────────────────────────

def s3_read(key: str) -> str | None:
    """Return object body as str, or None if it doesn't exist."""
    try:
        obj = s3.get_object(Bucket=S3_BUCKET, Key=key)
        return obj["Body"].read().decode("utf-8")
    except ClientError as exc:
        if exc.response["Error"]["Code"] in ("NoSuchKey", "404"):
            return None
        raise

def s3_write_bytes(key: str, data: bytes, content_type: str = "application/octet-stream") -> None:
    s3.put_object(Bucket=S3_BUCKET, Key=key, Body=data, ContentType=content_type)

def s3_write_json(key: str, obj: object) -> None:
    s3_write_bytes(key, json.dumps(obj, separators=(",", ":")).encode(), "application/json")

def list_user_prefixes() -> list[str]:
    """Return all virtual-folder prefixes directly under S3_PREFIX/."""
    results: list[str] = []
    paginator = s3.get_paginator("list_objects_v2")
    for page in paginator.paginate(
        Bucket=S3_BUCKET, Prefix=f"{S3_PREFIX}/", Delimiter="/"
    ):
        for cp in page.get("CommonPrefixes", []):
            results.append(cp["Prefix"])
    return results

# ── CSV parsing ───────────────────────────────────────────────────────────────

def parse_deck_csv(text: str) -> list[tuple[str, list[str]]]:
    """Return list of (word, [example, ...]) from deck CSV text."""
    rows: list[tuple[str, list[str]]] = []
    for row in csv.reader(io.StringIO(text)):
        if not row:
            continue
        word = row[0].strip()
        if not word:
            continue
        examples = [c.strip() for c in row[1:] if c.strip()]
        rows.append((word, examples))
    return rows

# ── Piper TTS ─────────────────────────────────────────────────────────────────

_warned_langs: set[str] = set()
_warned_langs_lock = threading.Lock()
# Per-language download locks: threads that need a model block here until
# the download completes, instead of racing and returning None immediately.
_download_locks: dict[str, threading.Lock] = {}
_download_locks_lock = threading.Lock()

def _get_download_lock(lang: str) -> threading.Lock:
    with _download_locks_lock:
        if lang not in _download_locks:
            _download_locks[lang] = threading.Lock()
        return _download_locks[lang]

def _download_model(stem: str) -> bool:
    """Download a piper voice model into MODELS_DIR. Returns True on success."""
    try:
        from piper.download_voices import download_voice  # type: ignore[import]
    except ImportError:
        print(f"   [error] piper.download_voices not available – install piper-tts: pip install piper-tts")
        return False

    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    print(f"   [download] downloading {stem} → {MODELS_DIR}/")
    try:
        download_voice(stem, MODELS_DIR)
    except Exception as exc:
        print(f"   [error] download failed: {exc}")
        return False

    ok = (MODELS_DIR / f"{stem}.onnx").exists()
    if ok:
        print(f"   [download] {stem} ready")
    else:
        print(f"   [error] download finished but {stem}.onnx not found in {MODELS_DIR}")
    return ok

def _model_path(lang: str) -> Path | None:
    stem = LANGUAGE_MODELS.get(lang)
    if not stem:
        with _warned_langs_lock:
            if lang not in _warned_langs:
                print(f"   [warn] no model mapping for language '{lang}'")
                _warned_langs.add(lang)
        return None

    p = MODELS_DIR / f"{stem}.onnx"
    if p.exists():
        return p

    # Serialize downloads per language: all threads wait on the same lock so
    # only one downloads while the rest block and then reuse the result.
    with _get_download_lock(lang):
        if p.exists():
            return p
        if not _download_model(stem):
            return None
        return p if p.exists() else None

def synthesize(text: str, lang: str) -> bytes | None:
    """Synthesize text with piper and return WAV bytes, or None on error."""
    model = _model_path(lang)
    if model is None:
        return None

    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        out_path = Path(tmp.name)

    try:
        result = subprocess.run(
            [PIPER_BIN, "--model", str(model), "--output_file", str(out_path)],
            input=text.encode("utf-8"),
            capture_output=True,
            timeout=60,
        )
        if result.returncode != 0:
            stderr = result.stderr.decode(errors="replace").strip()[:200]
            print(f"  [error] piper returned {result.returncode}: {stderr}")
            return None
        return out_path.read_bytes()
    except FileNotFoundError:
        sys.exit(
            f"piper binary not found at '{PIPER_BIN}'. "
            "Install piper or set PIPER_BIN to the correct path."
        )
    except subprocess.TimeoutExpired:
        print(f"  [error] piper timed out on: {text[:60]!r}")
        return None
    finally:
        out_path.unlink(missing_ok=True)

# ── Setup check ──────────────────────────────────────────────────────────────

def check_setup() -> None:
    """Print piper version and model availability, exit if piper is missing."""
    # Verify piper binary
    try:
        result = subprocess.run(
            [PIPER_BIN, "--version"],
            capture_output=True, timeout=10,
        )
        version = (result.stdout or result.stderr).decode(errors="replace").strip().splitlines()[0]
        print(f"piper binary : {PIPER_BIN}  ({version})")
    except FileNotFoundError:
        sys.exit(
            f"\n[error] piper binary not found at '{PIPER_BIN}'.\n"
            "  Install piper-tts (pip install piper-tts) or set PIPER_BIN."
        )
    except subprocess.TimeoutExpired:
        print(f"[warn] piper --version timed out, continuing anyway")

    # Ensure models directory exists
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    print(f"models dir   : {MODELS_DIR.resolve()}")

    found, missing = [], []
    for lang, stem in LANGUAGE_MODELS.items():
        p = MODELS_DIR / f"{stem}.onnx"
        if p.exists():
            found.append(lang)
        else:
            missing.append(f"{lang} ({stem}.onnx)")

    print(f"models found   : {', '.join(found) if found else 'none'}")
    if missing:
        print(f"models missing : {', '.join(missing)}  (will auto-download on first use)")
    print()

# ── Per-user processing ───────────────────────────────────────────────────────

def process_user(user_prefix: str, dry_run: bool, workers: int = 1) -> None:
    folder = user_prefix.rstrip("/").split("/")[-1]
    print(f"\n── {folder}")

    raw_decks = s3_read(f"{user_prefix}decks.json")
    if raw_decks is None:
        print("   no decks.json – skipping")
        return
    try:
        decks = json.loads(raw_decks)
    except json.JSONDecodeError:
        print("   malformed decks.json – skipping")
        return
    if not isinstance(decks, list) or not decks:
        print("   no decks")
        return

    manifest_key = f"{user_prefix}{MANIFEST_FILE}"
    manifest_raw = s3_read(manifest_key)
    manifest: dict[str, bool] = json.loads(manifest_raw) if manifest_raw else {}
    prior_hashes: set[str] = set(manifest.keys())
    manifest_dirty = False

    # ── collect work across all decks ────────────────────────────────────────
    # Stats per deck: cached/shared/total/new/failed + lang
    deck_stats: dict[str, dict] = {}
    ordered_names: list[str] = []
    # All items that need synthesis: (deck_name, h, text, lang, audio_key)
    pending: list[tuple[str, str, str, str, str]] = []

    for deck in decks:
        name = str(deck.get("name", "")).strip()
        lang = str(deck.get("lang", "")).strip().lower()
        if not name or not lang:
            continue

        safe_name = "".join(c if (c.isalnum() or c in "._-") else "_" for c in name)
        csv_key  = f"{user_prefix}deck-data-{safe_name}.csv"
        csv_text = s3_read(csv_key)
        if csv_text is None:
            print(f"   [{name}] no CSV yet – skipping")
            continue

        deck_rows = parse_deck_csv(csv_text)
        if not deck_rows:
            print(f"   [{name}] empty deck – skipping")
            continue

        stats = {"cached": 0, "shared": 0, "total": 0, "new": 0, "failed": 0, "lang": lang}
        deck_stats[name] = stats
        ordered_names.append(name)

        for word, examples in deck_rows:
            for text in [word] + examples:
                if not text:
                    continue
                stats["total"] += 1
                h = cell_hash(lang, text)
                if h in manifest:
                    if h in prior_hashes:
                        stats["cached"] += 1
                    else:
                        stats["shared"] += 1
                    continue
                audio_key = f"{user_prefix}{AUDIO_SUBDIR}/{h}.wav"
                pending.append((name, h, text, lang, audio_key))

    # ── synthesize (parallel) or dry-run ─────────────────────────────────────
    if dry_run:
        for dname, h, _text, _lang, _audio_key in pending:
            manifest[h] = True
            manifest_dirty = True
            deck_stats[dname]["new"] += 1
    elif pending:
        def _task(item: tuple[str, str, str, str, str]) -> tuple[str, str, bool]:
            dname, h, text, lang, audio_key = item
            wav = synthesize(text, lang)
            if wav is None:
                return dname, h, False
            s3_write_bytes(audio_key, wav, "audio/wav")
            return dname, h, True

        with ThreadPoolExecutor(max_workers=workers) as pool:
            futures = [pool.submit(_task, item) for item in pending]
            for fut in as_completed(futures):
                dname, h, success = fut.result()
                if success:
                    print(".", end="", flush=True)
                    manifest[h] = True
                    manifest_dirty = True
                    deck_stats[dname]["new"] += 1
                else:
                    print("x", end="", flush=True)
                    deck_stats[dname]["failed"] += 1

        if any(deck_stats[n]["new"] + deck_stats[n]["failed"] > 0 for n in ordered_names):
            print()  # end the dots line

    # ── per-deck summary ──────────────────────────────────────────────────────
    for name in ordered_names:
        s = deck_stats[name]
        parts = [f"lang={s['lang']}", f"new={s['new']}", f"cached={s['cached']}"]
        if s["shared"]:
            parts.append(f"shared={s['shared']}")
        if s["failed"]:
            parts.append(f"FAILED={s['failed']}")
        parts.append(f"total={s['total']}")
        print(f"   [{name}]  {'  '.join(parts)}")

    if manifest_dirty:
        if dry_run:
            print(f"   [dry-run] would update manifest ({len(manifest)} total entries)")
        else:
            s3_write_json(manifest_key, manifest)
            print(f"   manifest saved  ({len(manifest)} total entries)")

# ── Entry point ───────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(
        description="Pre-generate Piper TTS audio for all LingoPlayer decks in S3."
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Show what would be generated without calling piper or uploading anything.",
    )
    parser.add_argument(
        "--user",
        metavar="FOLDER",
        help="Process only this safeEmail folder (e.g. john_example_com).",
    )
    parser.add_argument(
        "--workers",
        type=int,
        default=os.cpu_count() or 4,
        metavar="N",
        help="Total parallel worker threads for synthesis (default: CPU count).",
    )
    args = parser.parse_args()

    if args.dry_run:
        print("═══ DRY RUN – nothing will be generated or uploaded ═══\n")
    else:
        check_setup()

    all_prefixes = list_user_prefixes()
    if not all_prefixes:
        print(f"No user folders found under s3://{S3_BUCKET}/{S3_PREFIX}/")
        return

    if args.user:
        target = f"{S3_PREFIX}/{args.user}/"
        prefixes = [p for p in all_prefixes if p == target]
        if not prefixes:
            sys.exit(f"User folder not found: {target}")
    else:
        prefixes = all_prefixes

    # Distribute workers across concurrent users so the total number of
    # simultaneous piper processes stays at most args.workers.
    user_threads  = min(args.workers, len(prefixes))
    synth_workers = max(1, args.workers // user_threads)

    print(
        f"Processing {len(prefixes)} user folder(s) in s3://{S3_BUCKET}/{S3_PREFIX}/  "
        f"[{user_threads} user thread(s) × {synth_workers} synthesis worker(s)]\n"
    )

    def _run_user(prefix: str) -> None:
        try:
            process_user(prefix, args.dry_run, synth_workers)
        except Exception as exc:  # noqa: BLE001
            print(f"  [error] unhandled exception for {prefix}: {exc}")

    if user_threads > 1:
        with ThreadPoolExecutor(max_workers=user_threads) as pool:
            list(pool.map(_run_user, prefixes))
    else:
        for prefix in prefixes:
            _run_user(prefix)

    print("\n══ Done ══")


if __name__ == "__main__":
    main()
