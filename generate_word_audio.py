#!/usr/bin/env python3
import asyncio
import argparse
import hashlib
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path


ROOT = Path(__file__).resolve().parent
WEB_DIR = ROOT / "word-web-cloud"
DEFAULT_SOURCES = {
    "primary": WEB_DIR / "words_primary.txt",
    "junior": WEB_DIR / "words_junior.txt",
    "senior": WEB_DIR / "words_senior.txt",
}
DEFAULT_ENDPOINT = "https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer"


def parse_args():
    parser = argparse.ArgumentParser(
        description="Generate word pronunciation mp3 files from txt vocabulary lists with Bailian or edge-tts."
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
        "--provider",
        choices=["bailian", "edge"],
        default="bailian",
        help="Which TTS provider to use.",
    )
    parser.add_argument(
        "--model",
        default="cosyvoice-v2",
        help="Bailian CosyVoice model to use.",
    )
    parser.add_argument(
        "--voice",
        default="longxiaochun_v2",
        help="Voice to use. For edge-tts, examples include en-US-EmmaNeural or en-US-AndrewNeural.",
    )
    parser.add_argument(
        "--format",
        default="mp3",
        choices=["mp3", "wav", "opus", "pcm"],
        help="Output audio format.",
    )
    parser.add_argument(
        "--sample-rate",
        type=int,
        default=22050,
        help="Output sample rate.",
    )
    parser.add_argument(
        "--text-template",
        default="{word}",
        help="Template used for TTS input text. Use {word} as the placeholder.",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=0,
        help="Only generate the first N words per level. 0 means no limit.",
    )
    parser.add_argument(
        "--words",
        nargs="+",
        default=[],
        help="Only generate the specified words within the selected levels.",
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
    parser.add_argument(
        "--retries",
        type=int,
        default=3,
        help="Retry attempts for transient API or download failures.",
    )
    parser.add_argument(
        "--concurrency",
        type=int,
        default=6,
        help="Concurrent requests when using edge-tts.",
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


def build_jobs(levels, limit: int, outdir: Path, ext: str):
    jobs = []
    for level in levels:
        source = DEFAULT_SOURCES[level]
        words = parse_word_list(source)
        if limit > 0:
            words = words[:limit]
        level_dir = outdir / level
        for word in words:
            filename = sanitize_filename(word) + f".{ext}"
            jobs.append((level, word, level_dir / filename))
    return jobs


def filter_jobs_by_words(jobs, selected_words):
    if not selected_words:
        return jobs
    selected = {word.strip().lower() for word in selected_words if word.strip()}
    return [job for job in jobs if job[1].strip().lower() in selected]


def get_api_key():
    return os.environ.get("DASHSCOPE_API_KEY") or os.environ.get("BAILIAN_API_KEY")


def bailian_tts(api_key: str, model: str, voice: str, text: str, fmt: str, sample_rate: int):
    payload = {
        "model": model,
        "input": {
            "text": text,
            "voice": voice,
            "format": fmt,
            "sample_rate": sample_rate,
            "language_hints": ["en"],
        },
    }
    request = urllib.request.Request(
        DEFAULT_ENDPOINT,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=120) as response:
        result = json.loads(response.read().decode("utf-8"))
    try:
        return result["output"]["audio"]["url"]
    except Exception as exc:
        raise RuntimeError(f"Unexpected Bailian response: {result}") from exc


def download_file(url: str, outfile: Path):
    outfile.parent.mkdir(parents=True, exist_ok=True)
    with urllib.request.urlopen(url, timeout=120) as response:
        data = response.read()
    outfile.write_bytes(data)


def generate_with_retry(api_key: str, args, word: str, outfile: Path):
    last_error = None
    text = args.text_template.format(word=word)
    for attempt in range(1, args.retries + 1):
        try:
            audio_url = bailian_tts(
                api_key=api_key,
                model=args.model,
                voice=args.voice,
                text=text,
                fmt=args.format,
                sample_rate=args.sample_rate,
            )
            download_file(audio_url, outfile)
            return
        except urllib.error.HTTPError as exc:
            body = exc.read().decode("utf-8", errors="ignore")
            last_error = f"HTTP {exc.code}: {body}"
        except Exception as exc:
            last_error = str(exc)

        if attempt < args.retries:
            time.sleep(1.2 * attempt)
    raise RuntimeError(last_error or "Unknown generation failure")


def import_edge_tts():
    try:
        import edge_tts  # type: ignore
    except ImportError as exc:
        raise RuntimeError(
            "edge-tts is not installed. Install it first, or run with PYTHONPATH pointing to the edge-tts package."
        ) from exc
    return edge_tts


async def edge_generate_with_retry(args, edge_tts_module, word: str, outfile: Path):
    last_error = None
    text = args.text_template.format(word=word)
    outfile.parent.mkdir(parents=True, exist_ok=True)
    tmpfile = outfile.with_suffix(outfile.suffix + ".tmp")

    for attempt in range(1, args.retries + 1):
        try:
            communicate = edge_tts_module.Communicate(text=text, voice=args.voice)
            await communicate.save(str(tmpfile))
            tmpfile.replace(outfile)
            return
        except Exception as exc:
            last_error = str(exc)
            if tmpfile.exists():
                tmpfile.unlink(missing_ok=True)
            if attempt < args.retries:
                await asyncio.sleep(1.2 * attempt)
    raise RuntimeError(last_error or "Unknown generation failure")


async def run_edge_jobs(args, queued):
    edge_tts_module = import_edge_tts()
    failures = []
    started = time.time()
    semaphore = asyncio.Semaphore(max(1, args.concurrency))

    async def worker(idx, level, word, outfile):
        print(f"[{idx}/{len(queued)}] {level:<7} {word} -> {outfile.name}")
        async with semaphore:
            try:
                await edge_generate_with_retry(args, edge_tts_module, word, outfile)
            except Exception as exc:
                failures.append((level, word, str(exc)))
                print(f"  failed: {exc}", file=sys.stderr)
            if args.sleep > 0:
                await asyncio.sleep(args.sleep)

    await asyncio.gather(*(worker(idx, level, word, outfile) for idx, (level, word, outfile) in enumerate(queued, start=1)))

    elapsed = time.time() - started
    print(f"Done in {elapsed:.1f}s")
    print(f"Success: {len(queued) - len(failures)}")
    print(f"Failed: {len(failures)}")

    if failures:
        print("\nFailures:", file=sys.stderr)
        for level, word, error in failures[:30]:
            print(f"- {level} / {word}: {error}", file=sys.stderr)
        raise RuntimeError("Some edge-tts jobs failed")


def main():
    args = parse_args()
    api_key = get_api_key()
    if not args.dry_run and args.provider == "bailian" and not api_key:
        print("Missing DASHSCOPE_API_KEY (or BAILIAN_API_KEY).", file=sys.stderr)
        sys.exit(1)

    outdir = Path(args.outdir).resolve()
    jobs = build_jobs(args.levels, args.limit, outdir, args.format)
    jobs = filter_jobs_by_words(jobs, args.words)
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

    if args.provider == "edge":
        try:
            asyncio.run(run_edge_jobs(args, queued))
        except RuntimeError:
            sys.exit(1)
        return

    failures = []
    started = time.time()

    for idx, (level, word, outfile) in enumerate(queued, start=1):
        print(f"[{idx}/{len(queued)}] {level:<7} {word} -> {outfile.name}")
        try:
            generate_with_retry(api_key, args, word, outfile)
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
