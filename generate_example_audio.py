import argparse
import asyncio
from pathlib import Path

import edge_tts


ROOT = Path(__file__).resolve().parent


def parse_words(path: Path):
    for line in path.read_text(encoding="utf-8-sig").splitlines():
        parts = line.split("/", 4)
        if len(parts) == 5 and parts[0].strip() and parts[4].strip():
            yield parts[0].strip(), parts[4].strip()


def safe_name(word: str) -> str:
    return "".join(ch if ch.isalnum() or ch in "._-" else "_" for ch in word).strip(".")


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--concurrency", type=int, default=8)
    args = parser.parse_args()

    out = ROOT / "word-web-cloud" / "audio" / "primary-sentence"
    out.mkdir(parents=True, exist_ok=True)
    jobs = [(word, sentence) for word, sentence in parse_words(ROOT / "word-web-cloud" / "words_primary.txt")]
    if args.limit:
        jobs = jobs[:args.limit]
    queue = asyncio.Semaphore(max(1, args.concurrency))

    async def generate(index, word, sentence):
        target = out / f"{safe_name(word)}.mp3"
        if target.exists() and target.stat().st_size > 100:
            return
        tmp = target.with_suffix(".tmp.mp3")
        async with queue:
            for attempt in range(3):
                try:
                    await edge_tts.Communicate(sentence, "en-US-EmmaNeural", rate="-5%", volume="+0%").save(str(tmp))
                    tmp.replace(target)
                    return
                except Exception:
                    if attempt == 2:
                        raise
                    await asyncio.sleep(2 ** attempt)
        
    total = len(jobs)
    done = 0
    for start in range(0, total, 64):
        batch = jobs[start:start + 64]
        await asyncio.gather(*(generate(start + i + 1, word, sentence) for i, (word, sentence) in enumerate(batch)))
        done += len(batch)
        print(f"{done}/{total}", flush=True)


if __name__ == "__main__":
    asyncio.run(main())
