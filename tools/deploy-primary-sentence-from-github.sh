#!/usr/bin/env bash
set -eu

repo="https://raw.githubusercontent.com/zechzhang-debug/dahuajiujiu/main/word-web-cloud"
tmp="/tmp/sentence-audio-live"
rm -rf "$tmp"
mkdir -p "$tmp/junior-sentence" "$tmp/senior-sentence"

download_level() {
  level="$1"
  curl -L --fail --silent --show-error --retry 5 --connect-timeout 15 "$repo/${level}-sentence-files.txt" -o "/tmp/${level}-sentence-files.txt"
  export repo tmp level
  sed '/^[[:space:]]*$/d' "/tmp/${level}-sentence-files.txt" | xargs -P 16 -n 1 -I {} sh -c 'f="$1"; curl -L --fail --silent --show-error --retry 5 --retry-delay 1 --connect-timeout 15 --max-time 90 "$repo/audio/$level-sentence/$f" -o "$tmp/$level-sentence/$f"' _ {}
  count=$(find "$tmp/$level-sentence" -type f -name '*.mp3' | wc -l)
  test "$count" -ge 1000
  echo "${level^^}_AUDIO_COUNT=$count"
}

download_level junior
download_level senior

base="/srv/dahuajiujiu/current"
stamp=$(date +%Y%m%d-%H%M%S)
backup="/srv/dahuajiujiu/backups/${stamp}-junior-senior-sentence-audio"
sudo mkdir -p "$backup"
sudo mkdir -p "$base/audio/junior-sentence" "$base/audio/senior-sentence"
sudo cp -a "$tmp/junior-sentence/." "$base/audio/junior-sentence/"
sudo cp -a "$tmp/senior-sentence/." "$base/audio/senior-sentence/"

echo "DEPLOYED"
echo "BACKUP=$backup"
