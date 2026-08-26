#!/bin/sh
# Skjut en byggd Torget-avbild över luften. Arbetsflödet (2026-08-14):
#
#   1. idf.py build                       (eller -B <byggkatalog>)
#   2. tools/ota-flash.sh <enhetens-ip>   — skriptet väntar på fönstret
#   3. Håll KEY3 ~3 s tills UPDATES ON-ringen syns — uppladdningen går av
#      sig själv, enheten verifierar SHA-256, byter lucka och startar om.
#   4. Efter omstarten återöppnas fönstret själv (PENDING_VERIFY-boot):
#      nästa bygge i samma arbetspass behöver inget nytt håll. Ett kort
#      KEY3-tryck stänger när passet är klart.
#
# Samtyckeskedjan är avsiktlig: fysiskt håll + token + tidsbegränsat
# fönster. Skriptet kan aldrig öppna fönstret åt dig — det är poängen.
# USB-C förblir räddningsvägen om en avbild inte bootar.
#
# Token lämnar aldrig Macen: uppladdningen bär ett BEVIS,
# X-VibePulse-Auth = hex(HMAC-SHA256(nyckel = token, meddelande = avbildens
# SHA-256-hex)). Enheten räknar fram samma HMAC och kräver dessutom att den
# strömmade avbilden har exakt den digest beviset täcker. Ett avlyssnat
# bevis duger därför bara till att skicka samma avbild igen, aldrig en annan.
set -eu
cd "$(dirname "$0")/.."

# IP:t kan bo i gitignorade .ota-device (repytroten) — då räcker
# `tools/ota-flash.sh` utan argument, från vilken agent-session som helst.
HOST=${1:-$(cat .ota-device 2>/dev/null || true)}
[ -n "$HOST" ] || {
  echo "usage: tools/ota-flash.sh <device-ip> [build-dir]" >&2
  echo "       (eller skriv enhetens IP i .ota-device i repytroten)" >&2
  exit 1
}
TOKEN=$(sed -n 's/.*TG_OTA_TOKEN[^"]*"\([0-9a-f]\{64\}\)".*/\1/p' secrets.h | head -1)
[ -n "$TOKEN" ] || { echo "inget TG_OTA_TOKEN i secrets.h — uppladdning avstängd" >&2; exit 1; }
BUILD_ARG=${2:-}

echo "väntar på underhållsfönstret på $HOST — håll KEY3 ~3 s..."
# Två fakta måste stämma innan något skickas: fönstret är öppet OCH den
# körande avbilden är inte längre PENDING_VERIFY. IDF vägrar esp_ota_begin
# medan hälsogrinden ännu dömer förra avbilden (ca 15 s efter en OTA-omstart)
# och enheten svarar 409 för det fallet; den kedjade utvecklingsrytmen väntar
# här i stället för att snubbla på det. Ett statussvar utan pending_verify
# är en äldre firmware som inte heller förstår beviset nedan, den måste
# uppdateras en gång över USB (eller med den gamla ota-flash.sh) först.
PENDING_SAID=0
while :; do
  STATUS=$(curl -s --max-time 2 "http://$HOST/api/ota/status" 2>/dev/null || true)
  case "$STATUS" in
    *'"maintenance_open":true'*)
      case "$STATUS" in
        *'"pending_verify":false'*) break ;;
        *'"pending_verify":true'*)
          if [ "$PENDING_SAID" = 0 ]; then
            echo "fönstret är öppet men förra avbilden väntar på hälsogrinden, väntar..."
            PENDING_SAID=1
          fi ;;
        *)
          echo "VÄGRAR: $HOST svarar utan pending_verify, äldre firmware som inte" >&2
          echo "        förstår uppladdningsbeviset. Flasha den en gång över USB först." >&2
          exit 1 ;;
      esac ;;
  esac
  sleep 1
done

# Filvalet sker HÄR, i uppladdningsögonblicket: en hårdkodad "build" (och
# ett val vid skriptstart, medan ett bygge ännu inte skrivit sin bin)
# sköt morgonens frysspöke till glaset 2026-08-14. Nyaste build*/torget.bin
# NU vinner, och namnet skrivs ut så avsändaren ser vad som faktiskt går.
BUILD=${BUILD_ARG:-$(ls -t build*/torget.bin 2>/dev/null | head -1 | xargs dirname 2>/dev/null)}
[ -n "$BUILD" ] || { echo "ingen build*/torget.bin — bygg först" >&2; exit 1; }
BIN="$BUILD/torget.bin"
[ -f "$BIN" ] || { echo "hittar inte $BIN — bygg först (idf.py build)" >&2; exit 1; }
SHA=$(shasum -a 256 "$BIN" | cut -d' ' -f1)

# Avsändargrinden (läxan 2026-08-14, då ett arkiverat -dirty-diagnosbygge
# gick till glaset och frös det): versionen läses ur BINÄRENS egen
# appbeskrivning och visas ALLTID; ett -dirty-bygge vägras utan uttryckligt
# TG_OTA_ALLOW_DIRTY=1. Enhetens grindar ser bara "en giltig avbild" —
# att den är RÄTT avbild är avsändarens ansvar, och nu även skriptets.
BIN_VERSION=$(dd if="$BIN" bs=1 skip=48 count=32 2>/dev/null | tr -d '\0')
echo "avbildens version: ${BIN_VERSION:-okänd}"
case "$BIN_VERSION" in
  *-dirty*)
    if [ "${TG_OTA_ALLOW_DIRTY:-0}" != "1" ]; then
      echo "VÄGRAR: $BIN_VERSION är ett -dirty-bygge." >&2
      echo "Committa först, eller kör TG_OTA_ALLOW_DIRTY=1 om du menar det." >&2
      exit 1
    fi
    echo "(-dirty släppt igenom av TG_OTA_ALLOW_DIRTY=1)"
    ;;
esac

# CI-BRYGGAN (beställd 2026-08-14, samma kväll som spökbinären): bara
# byggen vars commit har GRÖN CI får gå till glaset. Hashen tas ur
# versionssträngen (gXXXXXXX); en taggad version löses via git. Kräver
# nät + gh — offline-nödfall övermanas med TG_OTA_ALLOW_NO_CI=1.
if [ "${TG_OTA_ALLOW_NO_CI:-0}" != "1" ]; then
  case "$BIN_VERSION" in
    *-g*) BIN_COMMIT=${BIN_VERSION##*-g} ;;
    *)    BIN_COMMIT=$(git rev-parse --short "$BIN_VERSION" 2>/dev/null || true) ;;
  esac
  # gh:s --commit kräver FULL sha (kort hash ger tyst tom lista — mätt
  # 2026-08-14); rev-parse expanderar och bevisar samtidigt att committen
  # finns i det här trädet — en främmande binär vägras på köpet.
  BIN_COMMIT=$(git rev-parse "${BIN_COMMIT:-INGEN}" 2>/dev/null || true)
  if [ -z "${BIN_COMMIT:-}" ]; then
    echo "VÄGRAR: kan inte utläsa commit ur '$BIN_VERSION' — CI går inte att bevisa." >&2
    echo "        TG_OTA_ALLOW_NO_CI=1 om du menar det." >&2
    exit 1
  fi
  CI_GREEN=$(gh run list --commit "$BIN_COMMIT" --status success     --json databaseId --jq length 2>/dev/null || echo X)
  if [ "$CI_GREEN" = "X" ]; then
    echo "VÄGRAR: kan inte fråga GitHub om CI för $BIN_COMMIT (offline? gh?)." >&2
    echo "        TG_OTA_ALLOW_NO_CI=1 om du menar det." >&2
    exit 1
  fi
  if [ "${CI_GREEN:-0}" -lt 1 ]; then
    CI_PENDING=$(gh run list --commit "$BIN_COMMIT" --json status       --jq '[.[]|select(.status!="completed")]|length' 2>/dev/null || echo 0)
    if [ "${CI_PENDING:-0}" -ge 1 ]; then
      echo "VÄGRAR: CI för $BIN_COMMIT kör fortfarande — vänta på grönt." >&2
    else
      echo "VÄGRAR: ingen grön CI för $BIN_COMMIT (opushad? röd?)." >&2
    fi
    echo "        TG_OTA_ALLOW_NO_CI=1 om du menar det." >&2
    exit 1
  fi
  echo "CI grön för $BIN_COMMIT ($CI_GREEN körning(ar))"
fi

# Uppladdningsbeviset: HMAC-SHA256 med token (dess 64 ASCII-tecken) som
# nyckel över avbildens SHA-256-hex (64 tecken, utan radbrytning). Kontrol-
# lerat 2026-08-26 mot Pythons hmac med en känd vektor:
#   nyckel = "b"*64, meddelande = "a"*64
#   printf '%s' "$MSG" | openssl dgst -sha256 -hmac "$KEY" | awk '{print $NF}'
#   == hmac.new(b"b"*64, b"a"*64, hashlib.sha256).hexdigest()
#   == b9e5ca0b1bb0216bd222b79cdf8d037b8d74e679bcc70968a47117165e2e6357
# OpenSSL 3 skriver "SHA2-256(stdin)= <hex>", LibreSSL (macOS) "(stdin)= <hex>";
# awk:s sista fält är hexen i båda. test_ota_sender_gates.py kör samma
# rörledning mot vektorn där openssl finns. (Nyckeln syns kort i openssl:s
# argv på DEN HÄR Macen, som redan bär secrets.h. Den går aldrig på nätet.)
PROOF=$(printf '%s' "$SHA" | openssl dgst -sha256 -hmac "$TOKEN" | awk '{print $NF}')
printf '%s' "$PROOF" | grep -Eq '^[0-9a-f]{64}$' || {
  echo "kunde inte räkna fram uppladdningsbeviset (openssl dgst -hmac saknas?)" >&2
  exit 1
}

echo "fönstret öppet — laddar upp $BIN ($(wc -c < "$BIN" | tr -d ' ') byte):"
# Enhetens svar avgör utgången, inte att curl kom tillbaka: allt utom 202
# är ett avslag (409 = förra avbilden ännu inte godkänd, 401 = beviset
# underkänt, 403 = fönstret stängt eller avbilden förkastad efter
# överföringen) och skriptet slutar då med fel i stället för att skriva
# framgångsraden ovanpå ett 500 (som det gjorde 2026-08-26).
REPLY=$(mktemp)
trap 'rm -f "$REPLY"' EXIT
RESULT=$(curl -s --max-time 300 -o "$REPLY" -w '%{http_code} %{time_total}' \
  -X POST "http://$HOST/api/ota/firmware" \
  -H "X-VibePulse-Project: torget" \
  -H "X-VibePulse-Chip: esp32s3" \
  -H "X-VibePulse-SHA256: $SHA" \
  -H "X-VibePulse-Auth: $PROOF" \
  --data-binary "@$BIN") || RESULT="000 0"
CODE=${RESULT%% *}
SECS=${RESULT#* }
echo "HTTP $CODE på ${SECS}s: $(cat "$REPLY")"
if [ "$CODE" != "202" ]; then
  echo "VÄGRAD av enheten (HTTP $CODE): avbilden är INTE vald för nästa boot." >&2
  case "$CODE" in
    409) echo "        förra avbilden väntar ännu på hälsogrinden; kör igen om en stund." >&2 ;;
    401) echo "        beviset underkändes: TG_OTA_TOKEN i secrets.h matchar inte enhetens." >&2 ;;
    403) echo "        fönstret stängdes, eller avbilden förkastades efter överföringen." >&2 ;;
    000) echo "        ingen kontakt med $HOST." >&2 ;;
  esac
  exit 1
fi
echo "202 = avbilden vald för nästa boot; enheten startar om inom ett par sekunder."
