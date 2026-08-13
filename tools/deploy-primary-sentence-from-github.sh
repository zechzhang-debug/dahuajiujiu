#!/usr/bin/env bash
set -eu

repo="https://raw.githubusercontent.com/zechzhang-debug/dahuajiujiu/main/word-web-cloud"
tmp="/tmp/primary-sentence-live"
rm -rf "$tmp"
mkdir -p "$tmp"

curl -L --fail --silent --show-error "$repo/primary-sentence-files.txt" -o /tmp/primary-sentence-files.txt
while IFS= read -r file; do
  [ -n "$file" ] || continue
  curl -L --fail --silent --show-error --retry 3 "$repo/audio/primary-sentence/$file" -o "$tmp/$file"
done < /tmp/primary-sentence-files.txt

count=$(find "$tmp" -type f -name '*.mp3' | wc -l)
test "$count" -ge 1200

curl -L --fail --silent --show-error "$repo/english.html" -o /tmp/english.html
curl -L --fail --silent --show-error "$repo/english-mobile.html" -o /tmp/english-mobile.html

base="/srv/dahuajiujiu/current"
stamp=$(date +%Y%m%d-%H%M%S)
backup="/srv/dahuajiujiu/backups/${stamp}-primary-sentence-audio"
sudo mkdir -p "$backup"
sudo cp -a "$base/english.html" "$base/english-mobile.html" "$backup/"
sudo mkdir -p "$base/audio/primary-sentence"
sudo cp -a "$tmp/." "$base/audio/primary-sentence/"
sudo cp /tmp/english.html /tmp/english-mobile.html "$base/"

echo "DEPLOYED"
echo "AUDIO_COUNT=$count"
echo "BACKUP=$backup"
