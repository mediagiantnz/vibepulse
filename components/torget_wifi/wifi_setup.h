#ifndef TORGET_WIFI_SETUP_H
#define TORGET_WIFI_SETUP_H

/*
 * Setupfönstret: panelen reser sin egen accesspunkt så ett nytt nät kan
 * läggas till UTAN ombygge och USB-flashning. Fönstret är den enda vägen
 * in — det finns ingen endpoint på det vanliga LAN:et som kan ändra
 * nätverkslistan.
 *
 * Samtyckesmodellen ärvs från OTA (docs/ota.md), med en skillnad som är
 * medveten: fönstret kan också öppna sig SJÄLVT efter TG_WIFI_SETUP_AUTO_US
 * utan IP, så en panel på ett hotellrum inte kräver att man vet en hemlig
 * gest för att bli användbar igen. Var ärlig om vad det betyder: "90 s
 * utan IP" kan tillverkas utifrån av den som kan hålla stationen borta
 * från sitt nät (en oautentiserad deauth-flod räcker), så det automatiska
 * fönstret ska antas gå att öppna på avstånd. Därför får det ALDRIG det
 * token-härledda lösenordet: det får ett slumpat som bara står på glaset
 * (tg_wifi_ap_psk_source), och det kan ändå inte göra mer än lägga till ett
 * nät i listan. Faktorerna är kvar:
 *
 *  1. Fysisk närvaro - accesspunktens lösenord står på glaset. För ett
 *     fönster som öppnats med KEY3-hållet är secrets.h på Macen en lika god
 *     nyckel (lösenordet härleds ur token); för ett fönster som öppnat sig
 *     självt finns lösenordet bara på glaset. Den som varken ser skärmen
 *     eller höll knappen kommer inte in.
 *  2. Tid — fönstret stänger sig självt efter tio minuter, och allt minne
 *     det kostade lämnas tillbaka. Http-servern och accesspunkten existerar
 *     bara medan fönstret är öppet (lata ytan, frysläxan 2026-08-14).
 *
 * Fönstret kan ALDRIG skriva firmware. Det rör nätverkslistan i NVS och
 * ingenting annat; OTA:s uppladdning har kvar sin egen grind och sitt eget
 * token.
 */

#include <stdbool.h>
#include <stddef.h>

typedef struct {
  /* Panelflushens DMA-behov i byte (DISPLAY_FLUSH_ROWS x 480 x 2) — golvet
   * DMA-grindarna mäter mot. 0 = grindarna vägrar öppna (hellre ett stängt
   * fönster än en frusen panel). */
  size_t flush_dma_bytes;
  /* Har STA:n en IP just nu? Vakten frågar var halvsekund. */
  bool (*have_ip)(void);
  /* En uppkoppling lyckades just. Anropas från VAKTENS task, inte från
   * event-loopen: det är här värdlagret får röra flashen (flytta upp nätet
   * i listan) utan att blockera eventhanteringen eller spränga dess
   * stack. Får vara NULL. */
  void (*ip_acquired)(void);
  /* Pausa STA-jakten medan radion skannar och håller accesspunkten. */
  void (*sta_pause)(bool paused);
  /* Prova uppgifterna DIREKT UR MINNET. De finns inte i NVS ännu. */
  bool (*try_credentials)(const char *ssid, const char *password);
  /* Vakten har fått IP och sparat uppgifterna; gör försöket till ordinarie
   * kandidat utan att bryta den fungerande anslutningen. */
  void (*credentials_accepted)(const char *ssid);
  /* Fönstret stängs utan godkänt försök: glöm RAM-kopian och återställ den
   * tidigare kandidatlistan. */
  void (*credentials_abandoned)(void);
  /* Numerisk ESP-IDF-orsak för portalens retry-svar (0 = försöker ännu). */
  int (*last_disconnect_reason)(void);
  /* Nätet STA:n jagar just nu, för den ärliga nätsidan (får vara NULL). */
  const char *(*current_ssid)(void);
  /* Senaste frånkopplingsorsaken i klartext, eller NULL. */
  const char *(*last_reason)(void);
} tg_wifi_setup_hooks;

/* Startar vakten. Hooks måste överleva anropet (statisk struct). */
void torget_wifi_setup_start(const tg_wifi_setup_hooks *hooks);

/* KEY3-hållets väg in. STARTING äger knappen omedelbart och vakten väcks. */
void torget_wifi_setup_request_open(void);

/* Kort KEY3-tryck medan fönstret är öppet: stäng i förtid. */
void torget_wifi_setup_request_close(void);

/* Äger nätlagret glaset just nu? main.c använder det för att avgöra vad
 * ett KEY3-håll ska betyda. */
bool torget_wifi_setup_is_open(void);

/* Äger någon setupfas KEY3, även medan AP:n fortfarande startar? */
bool torget_wifi_setup_owns_input(void);

#endif
