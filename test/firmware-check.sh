#!/bin/sh
# Firmware build check, run by ./test/run.sh when idf.py is on PATH (or on
# its own: ./test/firmware-check.sh). It builds the tracked tree for the
# ESP32-S3 with secrets.h.example and the default-off GitHub screen,
# notifications and sound switched on, so that opt-in path cannot rot
# behind its switches.
#
# It builds in a throwaway copy: your own secrets.h and build*/ folders are
# never touched, and tools/ota-flash.sh can never pick this binary up.
# Use the ESP-IDF version the project pins (v5.5.2): source its export.sh
# first.
set -eu
cd "$(dirname "$0")/.."

command -v idf.py >/dev/null 2>&1 || {
  echo "ERROR: idf.py is not on PATH. Source ESP-IDF v5.5.2's export.sh first." >&2
  exit 1
}

WORK=$(mktemp -d "${TMPDIR:-/tmp}/vibepulse-fw-check.XXXXXX")
trap 'rm -rf "$WORK"' EXIT

git ls-files -z | tar --null -T - -cf - | tar -xf - -C "$WORK"

cp secrets.h.example "$WORK/secrets.h"
sed -i.bak 's/TK_GITHUB_SCREEN_ENABLED 0/TK_GITHUB_SCREEN_ENABLED 1/' "$WORK/secrets.h"
sed -i.bak 's/TK_GITHUB_NOTIFICATIONS_ENABLED 0/TK_GITHUB_NOTIFICATIONS_ENABLED 1/' "$WORK/secrets.h"
sed -i.bak 's/TK_GITHUB_SOUND_ENABLED 0/TK_GITHUB_SOUND_ENABLED 1/' "$WORK/secrets.h"
rm -f "$WORK/secrets.h.bak"
for flag in SCREEN NOTIFICATIONS SOUND; do
  grep -q "TK_GITHUB_${flag}_ENABLED 1" "$WORK/secrets.h" || {
    echo "ERROR: could not switch TK_GITHUB_${flag}_ENABLED on in secrets.h.example" >&2
    exit 1
  }
done

IDF_TARGET=esp32s3 idf.py -C "$WORK" build
echo "OK: firmware builds with the optional GitHub path switched on"
