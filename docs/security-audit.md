# Security-Audit: reefcloud (lokale Reef-Factory-Ersatz-Cloud)

**Datum:** 2025-08 · **Branch:** task/security · **Kontext:** ausschließlicher LAN-Betrieb beim Hausbesitzer, keine Internet-Exposition geplant. Der Tunnel nach donath-home.de ist die einzige bewusste Ausgehend-Verbindung.

## Executive Summary

reefcloud ist für einen LAN-Ersatz-Cloud-Server solide gebaut: Frame-Codec ist absturzsicher,
TLS-Schlüssel werden mit 0600 erzeugt, der Tunnel-Token wird nicht geloggt, und die
Frame-Handler sind gegen Exceptions abgesichert. Vier Härtungs-Fixes wurden direkt
umgesetzt und committed: 1-MB-Body-Limit an der HTTP-API, `maxPayload` 1 MB an allen
WebSocket-Servern (statt 100-MiB-Default), .env-Dateirechte 0600 und innerHTML-freies
Rendering im Setup-Wizard. Die gewichtigsten offenen Punkte liegen in der komplett
unauthentifizierten JSON-API auf Port 8080: Jeder LAN-Teilnehmer kann Aquariengeräte
steuern und — kritischster Einzelpunkt — über `/api/setup` den Tunnel-Token und die
Tunnel-URL überschreiben. Kombiniert mit `Access-Control-Allow-Origin: *` ist die API
zusätzlich aus jedem Browser heraus fernsteuerbar (Drive-by über besuchte Webseiten).
Ob hier Authentifizierung eingeführt wird, ist eine Owner-Entscheidung (siehe §2/§3).

---

## 1. Statische Auslieferung / Path-Traversal

**Schweregrad: niedrig (mit einem echten Restrisiko: mittel)**

- **Fundstelle:** `reef-cloud-v2.mjs:1114-1115` (`path.normalize` + `startsWith`-Guard),
  Auslieferung aus `webui/dist`; `setup.html` wird über feste Pfade (`:1096-1103`)
  ausgeliefert und ist nicht traversierbar.
- **Beschreibung:** Der Guard `fp.startsWith(WEBUI_DIR)` blockiert klassische
  `../`-Traversal zuverlässig (inkl. Backslash-Varianten unter Windows, da
  `path.normalize` sie kollabiert; `decodeURIComponent` wirft bei kaputten
  `%`-Sequenzen und landet im 400-Catch). Zwei Edge-Cases bleiben:
  1. **Präfix-Falle:** `WEBUI_DIR` endet ohne Separator. Ein hypothetischer
     Geschwister-Pfad wie `webui/dist-evil/…` würde den `startsWith`-Test bestehen.
     Existiert aktuell kein solches Verzeichnis — aber der Guard ist fragil.
  2. **Symlinks:** `normalize` löst keine Symlinks auf. Ein Symlink innerhalb von
     `webui/dist` auf ein Ziel außerhalb passiert den Guard. Angreifer müsste dafür
     bereits Schreibzugriff auf das Build-Verzeichnis haben → im LAN-Kontext
     praktisch irrelevant.
- **Empfehlung:** Guard präzisieren:
  `if (fp !== WEBUI_DIR && !fp.startsWith(WEBUI_DIR + path.sep)) { 403 }`.
  Optional `fs.realpath` für Symlink-Auflösung. Nicht umgesetzt (Verhaltensänderung
  an einem verifizierten Codepfad — Owner-Entscheidung).

## 2. Unauthentifizierte Endpunkte im LAN (Port 8080, plain HTTP)

**Schweregrad: mittel — `/api/setup` grenzwertig kritisch im LAN-Kontext**

- **Fundstellen:** `reef-cloud-v2.mjs:987` (`POST /api/command`), `:998`
  (`/api/capture`), `:1008` (`/api/program`), `:1064-1094` (`/api/setup/status`,
  `/api/setup/test`, `/api/setup`).
- **Beschreibung:** Die gesamte JSON-API ist ohne jede Authentifizierung erreichbar.
  Konsequenzen je Endpunkt:
  - `/api/command`: direkte Gerätesteuerung (Pumpenleistung, Fütterung, Rollenwechsel,
    Lichtprogramme). Schadenspotenzial real, aber auf Aquarium-Aktorik begrenzt.
  - `/api/setup`: **gewichtigster Befund.** Ein LAN-Angreifer (Gast-WLAN,
    kompromittiertes IoT-Gerät) kann Tunnel-URL **und** Token überschreiben und den
    ausgehenden Tunnel auf einen eigenen Server umleiten — danach laufen alle
    Geräte-Snapshots und Kommandos über den Angreifer. Der bestehende Token muss
    dafür nicht bekannt sein (leeres Feld = wird ersetzt, sobald ein neuer gesetzt
    wird).
  - `/api/capture`: schaltet den Roh-Frame-Capture (enthält u. a. Login-Payloads der
    Geräte) ein und liest ihn aus.
  - `/api/program`: schreibt Dateien (siehe §4) und lädt Lichtprogramme zur Lampe.
- **Bewertung:** Im reinen Heim-LAN mit nur eigenen Geräten vertretbar, aber das
  Gast-WLAN-/IoT-Szenario ist realistisch. Kein Fix ohne Produktentscheidung möglich
  (Auth-Konzept betrifft Web-UI, Tunnel-Kompatibilität, Setup-Flow).
- **Empfehlung (Owner-Entscheidung):** Mindestens einen der drei Wege:
  1. Optionaler API-Token (Header), im Setup-Wizard setzbar; Web-UI sendet ihn mit.
  2. `/api/setup*` nach Abschluss der Ersteinrichtung sperren (nur noch per
     Datei-Edit auf dem Pi änderbar).
  3. Web-Server nur auf die LAN-Interface-IP binden + Firewall-Regel gegen Gast-WLAN.

## 3. CORS `Access-Control-Allow-Origin: *` an der JSON-API

**Schweregrad: mittel**

- **Fundstellen:** `reef-cloud-v2.mjs:942` (`webSendJson`, alle API-Antworten inkl.
  Preflight-Handling `:976`), `:830` (HTTP-Fallback-Antworten auf 443/444).
- **Beschreibung:** Weil die API gleichzeitig unauthentifiziert ist (§2), erlaubt
  CORS `*` jeder beliebigen Webseite, die der Owner im Browser aufruft, per
  `fetch('http://<pi-ip>:8080/api/command', …)` Geräte zu steuern oder
  `/api/setup` zu beschreiben — die LAN-Grenze wird durch den Browser des Owners
  unterlaufen ("Drive-by"). Preflight für `content-type: application/json` wird
  ausdrücklich mit `*` beantwortet.
- **Empfehlung:** CORS-Header an der API entfernen (die Web-UI wird same-origin von
  derselben Port-8080-Instanz ausgeliefert und braucht kein CORS) oder auf den
  eigenen Origin einschränken. Nicht umgesetzt, falls die API bewusst auch
  cross-origin (z. B. von anderen lokalen Tools/Dashboards) genutzt wird —
  Owner-Entscheidung.

## 4. Path-Traversal über `serial` bei den Programm-Endpunkten

**Schweregrad: mittel**

- **Fundstellen:** `reef-cloud-v2.mjs:910` (`loadProgram`, GET) und `:1032`
  (`fs.writeFileSync(path.join(PROGRAM_DIR, serial + '.json'))`, POST).
- **Beschreibung:** `serial` kommt unvalidiert aus Query/Body. Ein Wert wie
  `../../reef-cloud-v2` führt beim POST zum Schreiben einer Datei
  `programs/../../reef-cloud-v2.json` — also außerhalb von `programs/`. Es ist kein
  beliebiges Überschreiben (Suffix `.json`, Inhalt ist sanitiertes Programm-JSON),
  aber gezieltes Anlegen/Überschreiben von `<name>.json` im Projektbaum ist möglich.
  Beim GET kann man beliebige `*.json`-Dateien lesen (Fehler → `null`, kein Leak des
  Inhalts außer bei parsebarem JSON, das als `program` zurückgeht).
- **Empfehlung:** `serial` serverseitig validieren, z. B.
  `if (!/^[A-Z0-9]{4,32}$/i.test(serial)) throw new Error('serial ungültig')` —
  an beiden Stellen (GET/POST `/api/program`). Nicht im Fix-Umfang enthalten
  (Eingabeverhalten der API ändert sich bei exotischen, bisher geduldeten Serials).

## 5. Fehlende Größenlimits — **behoben**

**Schweregrad vor Fix: mittel (DoS im LAN) → behoben**

- **Fundstellen (vor Fix):** `webReadBody()` ohne Limit (jetzt
  `reef-cloud-v2.mjs:945-971`); `WebSocketServer` ohne `maxPayload` (ws-Default
  100 MiB) an allen Instanzen.
- **Beschreibung:** Ohne Body-Limit konnte ein einzelner POST gegen
  `/api/command`, `/api/program`, `/api/setup` usw. den Arbeitsspeicher beliebig
  füllen (`Buffer.concat` ohne Obergrenze). An den WS-Servern erlaubte der
  ws-Default Frames bis 100 MiB je Nachricht — bei vier offenen Listenern
  (443/444/442/80) ungebremster Memory-Pressure.
- **Umgesetzte Fixes:**
  - **Commit `20d3051`:** `webReadBody()` lehnt Bodies > 1 MB ab; der Rest des
    Requests wird verworfen, die Verbindung endet sauber mit HTTP 400.
  - **Commit `7a1de31`:** `maxPayload: 1 * 1024 * 1024` an allen
    `WebSocketServer`-Instanzen (`reef-cloud-v2.mjs:840`, `reef-cloud.mjs` ×2,
    `reef-relay.mjs`). Echte Geräte-/App-Frames sind wenige KB groß; 1 MB ist
    großzügig bemessen.

## 6. Secrets: Dateirechte und Logging

**Schweregrad: niedrig (ein Punkt behoben, ein Punkt dokumentiert)**

- **.env-Dateirechte — behoben (Commit `72a9d04`):** `writeEnvConfig()`
  (`reef-cloud-v2.mjs:141-164`) schrieb `.env` bzw. `/boot/reef-cloud.env` mit
  umask-Default (typisch 0644) — der Tunnel-Token war für alle lokalen Benutzer
  lesbar. Jetzt `mode: 0o600` beim Schreiben **plus** `chmodSync` nachträglich,
  weil der `mode`-Parameter nur bei Neuanlage greift (Bestandsdateien aus frühen
  Setups behalten sonst 0644).
- **Zertifikats-Key:** wird bei Neuerzeugung korrekt mit 0600 geschrieben
  (`reef-cert.mjs:39`). Falls `reef-cloud-key.pem` noch aus der manuellen Phase 1
  stammt, einmalig `chmod 600` prüfen (manueller Schritt, Empfehlung).
- **Logging:**
  - Der **Tunnel-Token wird nirgends geloggt** (verifiziert: `launchTunnel`,
    `/api/setup`-Handler und `reef-tunnel.mjs` loggen nur URL/Status).
  - **Altgeräte-Logins landen mit Zugangsdaten im Klartext-Log:**
    `reef-cloud-v2.mjs:722` loggt `email=…, key=…` des Reef-Factory-Accounts.
    Zusätzlich enthalten Live-Captures (`dumps/live_capture/`, Capture-Ringpuffer
    und `/api/capture`) die kompletten `user/login`-Payloads mit E-Mail/Passwort.
    Das Log liegt ungeschützt neben dem Server.
  - **Empfehlung:** `key` im Login-Log maskieren (`key.slice(0,4) + '…'`) und im
    README vermerken, dass Log- und Dump-Dateien Account-Credentials enthalten
    können (Rotations-/Löschpflege). Nicht umgesetzt — das volle Logging ist für
    die laufende Protokoll-Analyse offenbar gewollt.

## 7. setup.html: XSS im Wizard — **behoben**

**Schweregrad vor Fix: niedrig → behoben**

- **Fundstelle (vor Fix):** `setup.html` `loadStatus()` — Server-Felder
  (`cert.cn`, `cert.notAfter`, `lanIps[].address`, `lanIps[].name`) wurden per
  `innerHTML` ins DOM gesetzt.
- **Beschreibung:** Die Daten stammen vom lokalen Server selbst (Zert-CN ist eine
  Konstante, Interface-Namen kommen aus `os.networkInterfaces()`), also praktisch
  nicht fremdsteuerbar — aber `innerHTML` mit Server-Daten ist ein Muster, das bei
  späteren Erweiterungen (z. B. Fehlertexte vom Tunnel-Server) sofort zur XSS-Lücke
  wird.
- **Umgesetzter Fix (Commit `d1539a0`):** Rendering vollständig auf
  `textContent`/DOM-Knoten umgestellt; `innerHTML` wird im Wizard nicht mehr
  verwendet. (Die Status-/Fehlermeldungen nutzten bereits durchgehend
  `textContent`.)

## 8. Frame-Codec: Robustheit gegen malformed Frames

**Schweregrad: hingenommen im LAN-Kontext**

- **Fundstellen:** `decodeFrame`/`encodeFrame` `reef-cloud-v2.mjs:39-51` (analog
  `reef-cloud.mjs:33-39`, `reef-relay.mjs:29-35`); Handler-Absicherung
  `reef-cloud-v2.mjs:877`.
- **Bewertung:**
  - `readStr()` ist durch `b.length` begrenzt — **keine Endlosschleife** möglich,
    auch ohne ein einziges NUL-Byte im Frame. Fehlende Terminatoren liefern leere
    Felder, kein Crash. Riesige Payloads erzeugen nur einen begrenzten
    `Buffer.from(slice)`; das eigentliche Risiko (Frame-Größe) ist mit Fix (b)
    durch `maxPayload` gedeckt.
  - `encodeFrame` baut Arrays per Spread — bei sehr großen Payloads wäre das
    langsam, aber alle Aufrufe nutzen servergenerierte, kleine Payloads.
  - In `reef-cloud-v2.mjs` sind alle `message`-Handler in try/catch gefasst
    (`:877`) — Exceptions einzelner Frames reißen den Prozess nicht um.
  - **Restrisiko:** `reef-cloud.mjs` und `reef-relay.mjs` haben **keinen**
    äußeren try/catch um die Message-Handler. Eine unerwartete Ausnahme (z. B. in
    `logFrame`/`handleFrame` bei exotischen Eingaben) würde als
    `uncaughtException` den Prozess beenden. Beide sind Analyse-/Mitschnitt-Tools,
    keine Produktivinstanz — hingenommen. Empfehlung: bei zukünftiger Nutzung
    denselben try/catch-Wrapper wie in v2 ergänzen.

## 9. TLS: selbst-signiertes Zertifikat mit CA:TRUE

**Schweregrad: hingenommen im LAN-Kontext**

- **Fundstelle:** `reef-cert.mjs:32-35` (BasicConstraints `cA: true, critical`,
  RSA 2048, 10 Jahre, CN/SAN `api.reeffactory.com`).
- **Bewertung:** Die Geräte-Firmware validiert das Zertifikat nachweislich nicht
  (sie akzeptiert das selbst-signierte Zert). CA:TRUE spiegelt das Original-Zert
  der echten Cloud und wurde so von den Geräten akzeptiert — daran nicht rühren,
  ein Wechsel auf CA:FALSE ist ein unnötiges Kompatibilitätsrisiko mit der
  Firmware. Das Zertifikat ist in keinem Trust-Store hinterlegt; ein Key-Leak
  ermöglicht daher kein CA-Missbrauchsszenario gegen Browser o. Ä. Wichtig ist
  nur die Schlüssel-Datei selbst (0600, siehe §6).
- **Empfehlung:** Keine Code-Änderung. Dokumentiert: Key nicht ins Repo committen,
  nicht weitergeben; bei Verlust neu erzeugen (automatischer Pfad vorhanden).

## 10. Reverse-Path: App↔Gerät-Routing ohne Autorisierung

**Schweregrad: hingenommen im LAN-Kontext**

- **Fundstellen:** `routeToDevice`/`routeToApps` `reef-cloud-v2.mjs:644-654`;
  Join/Routing-Logik `:797-827`; Geräteregistrierung per ungeprüftem
  Frame-Serial `:665-674, :705-713`.
- **Bewertung:** Jede verbundene App kann Frames mit beliebiger Serial senden und
  damit **jedes** Gerät ansprechen (nicht nur gejointe) — `joins` steuert nur den
  Empfang von Geräte-Push, nicht die Sendeberechtigung. Ebenso kann sich ein
  Gerät mit fremder Serial anmelden und die Registry überschreiben
  (`devices.set(serial, ws)` ohne Bindung an IP/Login-Kontext). Das spiegelt
  absichtlich das Verhalten der echten Cloud-Protokollfassade und ist im
  Heim-LAN (Akteure: eigene App, eigene Geräte) akzeptabel. Es existiert kein
  Broadcast-Mechanismus, mit dem eine App alle Geräte gleichzeitig adressieren
  könnte — Frames sind stets serial-adressiert.
- **Empfehlung:** Keine Änderung. Falls später Mehrbenutzer-/Gast-Szenarien
  entstehen, gemeinsam mit §2 (Auth) neu bewerten.

## 11. Sonstige Feststellungen (dokumentiert, kein Handlungsbedarf)

- **Plain-WS auf Port 442/80:** Altgeräte (FW 1.0.x/1.1.x) können kein TLS —
  unverschlüsselte Frames inkl. Login-Payloads im LAN. By design, im LAN
  hingenommen.
- **`reef-relay.mjs:120`:** `rejectUnauthorized: false` gegen die echte Cloud —
  MITM-Analysewerkzeug, per Definition bewusst so; nicht produktiv.
- **`reef-relay.mjs:18`:** Feste Cloud-IPs hardcodiert — kein Security-Thema,
  nur Wartung (DNS-Drift der echten Cloud).
- **`reef-cloud.mjs` TCP-Sonden (Port 8000/8080/…):** rein lesend; belegt aber
  u. a. Port 8080, falls es je parallel zur v2 läuft — Betriebshinweis, kein Fix.
- **Replay-Dumps (`dumps/`):** enthalten Account-/Gerätedaten der echten Cloud
  (E-Mail im tankList-Trailer, Login-Antworten). Liegen im Projektverzeichnis —
  beim Teilen/Veröffentlichen des Repos beachten.

---

## Anhang: Umgesetzte Fixes (Commits auf `task/security`)

| Commit | Fix | Dateien |
|---|---|---|
| `20d3051` | 1-MB-Body-Limit in `webReadBody()` | `reef-cloud-v2.mjs` |
| `7a1de31` | `maxPayload: 1 MB` an allen WebSocketServern | `reef-cloud-v2.mjs`, `reef-cloud.mjs`, `reef-relay.mjs` |
| `72a9d04` | `.env`/`/boot/reef-cloud.env` mit 0600 schreiben | `reef-cloud-v2.mjs` |
| `d1539a0` | Setup-Wizard ohne `innerHTML` (textContent/DOM) | `setup.html` |

## Offene Empfehlungen (Owner-Entscheidungen)

1. **Auth für die JSON-API** (§2), mindestens für `/api/setup*` — dringlichste
   offene Entscheidung.
2. **CORS einschränken/entfernen** (§3) — hängt davon ab, ob externe lokale
   Tools die API cross-origin nutzen.
3. **`serial`-Validierung** an `/api/program` (§4).
4. **startsWith-Guard präzisieren** (§1, Separator-Variante).
5. **Account-Key im Login-Log maskieren** (§6) + README-Hinweis zu
   Credentials in Logs/Dumps.
6. Optional: try/catch-Wrapper in `reef-cloud.mjs`/`reef-relay.mjs` (§8),
   `chmod 600 reef-cloud-key.pem` für Altbestand prüfen (§6).
