#!/usr/bin/env python3
import argparse
import hashlib
import re
import sys
import time
from pathlib import Path

try:
    from openai import OpenAI
except ImportError:
    print("Missing dependency: openai. Run: pip install openai", file=sys.stderr)
    sys.exit(1)


ROOT = Path(__file__).resolve().parent
WEB_DIR = ROOT / "word-web-cloud"
DEFAULT_SOURCES = {
    "primary": WEB_DIR / "words_primary.txt",
    "junior": WEB_DIR / "words_junior.txt",
    "senior": WEB_DIR / "words_senior.txt",
}


def parse_args():
    parser = argparse.ArgumentParser(
        description="Generate word pronunciation mp3 files from txt vocabulary lists."
    )
    parser.add_argument(
        "--levels",
        nargs="+",
        choices=sorted(DEFAULT_SOURCES.keys()),
        default=list(DEFAULT_SOURCES.keys()),
        help="Which word lists to process.",
    )
    parser.add_argument(
        "--outdir",
        default=str(WEB_DIR / "audio"),
        help="Output base directory for generated audio files.",
    )
    parser.add_argument(
        "--model",
        default="gpt-4o-mini-tts",
        help="TTS model to use.",
    )
    parser.add_argument(
        "--voice",
        default="alloy",
        help="TTS voice to use.",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=0,
        help="Only generate the first N words per level. 0 means no limit.",
    )
    parser.add_argument(
        "--overwrite",
        action="store_true",
        help="Regenerate files even if they already exist.",
    )
    parser.add_argument(
        "--sleep",
        type=float,
        default=0.0,
        help="Optional delay between requests in seconds.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Preview which files would be generated without calling the API.",
    )
    return parser.parse_args()


def sanitize_filename(word: str) -> str:
    cleaned = re.sub(r"[^a-zA-Z0-9]+", "_", word.strip().lower()).strip("_")
    if cleaned:
        return cleaned
    digest = hashlib.sha1(word.encode("utf-8")).hexdigest()[:10]
    return f"word_{digest}"


def parse_word_list(path: Path):
    words = []
    seen = set()
    with path.open("r", encoding="utf-8") as fh:
        for raw_line in fh:
            line = raw_line.strip()
            if not line or line.startswith("#"):
                continue
            word = line.split("/", 1)[0].strip()
            if not word:
                continue
            key = word.lower()
            if key in seen:
                continue
            seen.add(key)
            words.append(word)
    return words


def build_jobs(levels, limit: int, outdir: Path):
    jobs = []
    for level in levels:
        source = DEFAULT_SOURCES[level]
        words = parse_word_list(source)
        if limit > 0:
            words = words[:limit]
        level_dir = outdir / level
        for word in words:
            filename = sanitize_filename(word) + ".mp3"
            jobs.append((level, word, level_dir / filename))
    return jobs


def generate_audio(client: OpenAI, model: str, voice: str, word: str, outfile: Path):
    outfile.parent.mkdir(parents=True, exist_ok=True)
    response = client.audio.speech.create(
        model=model,
        voice=voice,
        input=word,
        response_format="mp3",
    )
    response.stream_to_file(outfile)


def main():
    args = parse_args()
    outdir = Path(args.outdir).resolve()
    jobs = build_jobs(args.levels, args.limit, outdir)
    print(f"Planned jobs: {len(jobs)}")

    skipped_existing = 0
    queued = []
    for level, word, outfile in jobs:
        if outfile.exists() and not args.overwrite:
            skipped_existing += 1
            continue
        queued.append((level, word, outfile))

    print(f"Existing files skipped: {skipped_existing}")
    print(f"Files to generate: {len(queued)}")

    if args.dry_run:
        for level, word, outfile in queued[:20]:
            print(f"[dry-run] {level:<7} {word:<24} -> {outfile}")
        if len(queued) > 20:
            print(f"... and {len(queued) - 20} more")
        return

    client = OpenAI()
    failures = []
    started = time.time()

    for idx, (level, word, outfile) in enumerate(queued, start=1):
        print(f"[{idx}/{len(queued)}] {level:<7} {word} -> {outfile.name}")
        try:
            generate_audio(client, args.model, args.voice, word, outfile)
        except Exception as exc:
            failures.append((level, word, str(exc)))
            print(f"  failed: {exc}", file=sys.stderr)
        if args.sleep > 0:
            time.sleep(args.sleep)

    elapsed = time.time() - started
    print(f"Done in {elapsed:.1f}s")
    print(f"Success: {len(queued) - len(failures)}")
    print(f"Failed: {len(failures)}")

    if failures:
        print("\nFailures:", file=sys.stderr)
        for level, word, error in failures[:30]:
            print(f"- {level} / {word}: {error}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
