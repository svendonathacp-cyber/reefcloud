# Security-Audit: reefcloud (lokale Reef-Factory-Ersatz-Cloud)

**Datum:** 2025-08 (aktualisiert nach Review-Nachbesserungen) · **Branch:** task/security · **Kontext:** ausschließlicher LAN-Betrieb beim Hausbesitzer, keine Internet-Exposition geplant. Der Tunnel zum konfigurierten externen Server ist die einzige bewusste Ausgehend-Verbindung.

## Executive Summary

reefcloud ist für einen LAN-Ersatz-Cloud-Server solide gebaut: Frame-Codec ist absturzsicher,
TLS-Schlüssel werden mit 0600 erzeugt, der Tunnel-Token wird nicht geloggt, und die
Frame-Handler sind gegen Exceptions abgesichert. Acht Härtungs-Fixes wurden umgesetzt und
committed: 1-MB-Body-Limit an der HTTP-API (inkl. sauberem Settle bei Client-Abbruch),
`maxPayload` 1 MB an allen WebSocket-Servern, .env-Dateirechte 0600, innerHTML-freies
Rendering im Setup-Wizard, serial-Validierung gegen Path-Traversal an `/api/program`,
Präzisierung des statischen Pfad-Guards und Maskierung des Account-Keys im Login-Log.
Die gewichtigsten **offenen** Punkte liegen in der weiterhin unauthentifizierten JSON-API
auf Port 8080: Jeder LAN-Teilnehmer kann Aquariengeräte steuern und — kritischster
Einzelpunkt — über `/api/setup` den Tunnel-Token und die Tunnel-URL überschreiben.
Kombiniert mit `Access-Control-Allow-Origin: *` ist die API zusätzlich aus jedem Browser
heraus fernsteuerbar. Ob hier Authentifizierung eingeführt wird, ist eine
Owner-Entscheidung (siehe §2/§3).

---

## 1. Statische Auslieferung / Path-Traversal — **behoben (Guard-Präzisierung)**

**Schweregrad vor Fix: niedrig (Restrisiko mittel) → behoben**

- **Fundstelle:** `reef-cloud-v2.mjs:1130-1131` (`path.normalize` + Guard),
  Auslieferung aus `webui/dist`; `setup.html` wird über feste Pfade ausgeliefert
  und ist nicht traversierbar.
- **Beschreibung:** Der Guard blockiert klassische `../`-Traversal zuverlässig
  (inkl. Backslash-Varianten unter Windows, da `path.normalize` sie kollabiert;
  `decodeURIComponent` wirft bei kaputten `%`-Sequenzen und landet im 400-Catch).
  Zwei Edge-Cases bestanden: (1) **Präfix-Falle** — `WEBUI_DIR` endet ohne
  Separator, ein hypothetischer Geschwister-Pfad wie `webui/dist-evil/…` hätte den
  `startsWith`-Test bestanden; (2) **Symlinks** — `normalize` löst keine Symlinks
  auf (angreifbar nur mit Schreibzugriff aufs Build-Verzeichnis → im LAN-Kontext
  praktisch irrelevant, dokumentiert).
- **Umgesetzter Fix (Commit `f0bde3f`):** Guard prüft jetzt auf exakte Gleichheit
  bzw. `fp.startsWith(WEBUI_DIR + path.sep)` — Geschwister-Verzeichnisse mit
  gemeinsamem Präfix rutschen nicht mehr durch.

## 2. Unauthentifizierte Endpunkte im LAN (Port 8080, plain HTTP)

**Schweregrad: mittel — `/api/setup` grenzwertig kritisch im LAN-Kontext — weiterhin offen (Owner-Entscheidung)**

- **Fundstellen:** `reef-cloud-v2.mjs:1000` (`POST /api/command`), `:1011`
  (`/api/capture`), `:1021` (`/api/program`), `:1078-1107` (`/api/setup/status`,
  `/api/setup/test`, `/api/setup`).
- **Beschreibung:** Die gesamte JSON-API ist ohne jede Authentifizierung erreichbar.
  Konsequenzen je Endpunkt:
  - `/api/command`: direkte Gerätesteuerung (Pumpenleistung, Fütterung, Rollenwechsel,
    Lichtprogramme). Schadenspotenzial real, aber auf Aquarium-Aktorik begrenzt.
  - `/api/setup`: **gewichtigster Befund.** Ein LAN-Angreifer (Gast-WLAN,
    kompromittiertes IoT-Gerät) kann Tunnel-URL **und** Token überschreiben und den
    ausgehenden Tunnel auf einen eigenen Server umleiten — danach laufen alle
    Geräte-Snapshots und Kommandos über den Angreifer. Der bestehende Token muss
    dafür nicht bekannt sein.
  - `/api/capture`: schaltet den Roh-Frame-Capture (enthält u. a. Login-Payloads der
    Geräte) ein und liest ihn aus.
  - `/api/program`: schreibt Dateien (jetzt serial-validiert, siehe §4) und lädt
    Lichtprogramme zur Lampe.
- **Bewertung:** Im reinen Heim-LAN mit nur eigenen Geräten vertretbar, aber das
  Gast-WLAN-/IoT-Szenario ist realistisch. Kein Fix ohne Produktentscheidung möglich
  (Auth-Konzept betrifft Web-UI, Tunnel-Kompatibilität, Setup-Flow).
- **Empfehlung (Owner-Entscheidung):** Mindestens einen der drei Wege:
  1. Optionaler API-Token (Header), im Setup-Wizard setzbar; Web-UI sendet ihn mit.
  2. `/api/setup*` nach Abschluss der Ersteinrichtung sperren (nur noch per
     Datei-Edit auf dem Pi änderbar).
  3. Web-Server nur auf die LAN-Interface-IP binden + Firewall-Regel gegen Gast-WLAN.

## 3. CORS `Access-Control-Allow-Origin: *` an der JSON-API

**Schweregrad: mittel — weiterhin offen (Owner-Entscheidung)**

- **Fundstellen:** `reef-cloud-v2.mjs:950` (`webSendJson`, alle API-Antworten inkl.
  Preflight-Handling `:990`), `:834` (HTTP-Fallback-Antworten auf 443/444).
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

## 4. Path-Traversal über `serial` bei den Programm-Endpunkten — **behoben**

**Schweregrad vor Fix: mittel → behoben**

- **Fundstellen:** `reef-cloud-v2.mjs:915` (`isValidSerial`), `:918` (`loadProgram`),
  `:1029` (GET-Prüfung), `:1043` (POST-Prüfung), `:1046` (Schreibpfad).
- **Beschreibung (vor Fix):** `serial` kam unvalidiert aus Query/Body. Ein Wert wie
  `../../reef-cloud-v2` führte beim POST zum Schreiben außerhalb von `programs/`
  (Suffix `.json`, Inhalt sanitiertes Programm-JSON — kein beliebiges Überschreiben,
  aber gezieltes Anlegen von `<name>.json` im Projektbaum); beim GET ließen sich
  beliebige `*.json`-Dateien lesen.
- **Umgesetzter Fix (Commit `110e68c`):** GET wie POST lehnen `serial` jetzt gegen
  `/^[A-Za-z0-9_-]{1,32}$/` ab — Traversal-Zeichen (`/`, `\`, `.`) sind nicht mehr
  zulässig. Fehlermeldung: `serial ungültig ([A-Za-z0-9_-]{1,32} erwartet)`.

## 5. Fehlende Größenlimits — **behoben**

**Schweregrad vor Fix: mittel (DoS im LAN) → behoben**

- **Fundstellen (nach Fix):** `webReadBody()` `reef-cloud-v2.mjs:957-986` (Limit
  `:959`, close-Handler `:982`); `maxPayload` an den `WebSocketServer`-Instanzen
  `reef-cloud-v2.mjs:844`, `reef-cloud.mjs:184` und `:217`, `reef-relay.mjs:96`.
- **Beschreibung (vor Fix):** Ohne Body-Limit konnte ein einzelner POST den
  Arbeitsspeicher beliebig füllen (`Buffer.concat` ohne Obergrenze). An den
  WS-Servern erlaubte der ws-Default Frames bis 100 MiB je Nachricht — bei vier
  offenen Listenern (443/444/442/80) ungebremster Memory-Pressure.
- **Umgesetzte Fixes:**
  - **Commit `20d3051`:** `webReadBody()` lehnt Bodies > 1 MB ab; der Rest des
    Requests wird verworfen, die Verbindung endet sauber mit HTTP 400.
  - **Commit `fa64492` (Review-Nachbesserung):** Die Promise settle't jetzt auch
    bei stillem Client-Abbruch (`req.on('close')` → reject), mit `settled`-Guard
    gegen doppeltes Settle — vorher konnte das `await webReadBody(req)` bei
    abgebrochener Verbindung ohne `error`-Event dauerhaft hängen.
  - **Commit `7a1de31`:** `maxPayload: 1 * 1024 * 1024` an allen
    `WebSocketServer`-Instanzen. Echte Geräte-/App-Frames sind wenige KB groß;
    1 MB ist großzügig bemessen.
- **Anmerkung (kein reales Risiko):** Der ausgehende Relay-Client in
  `reef-relay.mjs` (~:115, `new WebSocket(cloudUrl, …)` zur echten Cloud) hat
  eingehend kein eigenes `maxPayload` (ws-Default 100 MiB). Gegenstelle ist die
  echte Reef-Factory-Cloud, kein LAN-Angreifer — hingenommen.

## 6. Secrets: Dateirechte und Logging

**Schweregrad: niedrig (zwei Punkte behoben, einer dokumentiert)**

- **.env-Dateirechte — behoben (Commit `72a9d04`):** `writeEnvConfig()`
  (`reef-cloud-v2.mjs:141-164`) schrieb `.env` bzw. `/boot/reef-cloud.env` mit
  umask-Default (typisch 0644) — der Tunnel-Token war für alle lokalen Benutzer
  lesbar. Jetzt `mode: 0o600` beim Schreiben **plus** `chmodSync` nachträglich,
  weil der `mode`-Parameter nur bei Neuanlage greift.
- **Zertifikats-Key:** wird bei Neuerzeugung korrekt mit 0600 geschrieben
  (`reef-cert.mjs:39`). Falls `reef-cloud-key.pem` noch aus der manuellen Phase 1
  stammt, einmalig `chmod 600` prüfen (manueller Schritt, Empfehlung).
- **Logging:**
  - Der **Tunnel-Token wird nirgends geloggt** (verifiziert: `launchTunnel`,
    `/api/setup`-Handler und `reef-tunnel.mjs` loggen nur URL/Status).
  - **Account-Key im Altgeräte-Login-Log — behoben (Commit `74c7ce5`,
    `reef-cloud-v2.mjs:725-726`):** Die Logzeile loggte `email=…, key=…` im
    Klartext. Jetzt wird der Key maskiert (`key.slice(0, 2) + '***'`); die E-Mail
    bleibt zur Owner-Identifikation sichtbar.
  - **geConnect/login (neue Firmware) geprüft:** Dort wird die Login-Payload nur
    für `version` geparst (`:670`); kein Credential-/Token-Log vorhanden — nichts
    zu maskieren. (Anders in den Analyse-Tools: `reef-cloud.mjs`/`reef-relay.mjs`
    loggen absichtlich komplette Payloads inkl. Login — per Zweck Mitschnitt-Logger.)
  - **Weiterhin dokumentiert:** Live-Captures (`dumps/live_capture/`,
    Capture-Ringpuffer, `/api/capture`) enthalten die kompletten
    `user/login`-Payloads mit E-Mail/Passwort, solange der Capture-Schalter an ist.
    Empfehlung: README-Hinweis, dass Log- und Dump-Dateien Account-Credentials
    enthalten können (Rotations-/Löschpflege).

## 7. setup.html: XSS im Wizard — **behoben**

**Schweregrad vor Fix: niedrig → behoben**

- **Fundstelle (vor Fix):** `setup.html` `loadStatus()` — Server-Felder
  (`cert.cn`, `cert.notAfter`, `lanIps[].address`, `lanIps[].name`) wurden per
  `innerHTML` ins DOM gesetzt.
- **Beschreibung:** Die Daten stammen vom lokalen Server selbst (Zert-CN ist eine
  Konstante, Interface-Namen kommen aus `os.networkInterfaces()`), also praktisch
  nicht fremdsteuerbar — aber `innerHTML` mit Server-Daten ist ein Muster, das bei
  späteren Erweiterungen sofort zur XSS-Lücke wird.
- **Umgesetzter Fix (Commit `d1539a0`):** Rendering vollständig auf
  `textContent`/DOM-Knoten umgestellt; `innerHTML` wird im Wizard nicht mehr
  verwendet.

## 8. Frame-Codec: Robustheit gegen malformed Frames

**Schweregrad: hingenommen im LAN-Kontext**

- **Fundstellen:** `decodeFrame`/`encodeFrame` `reef-cloud-v2.mjs:39-51` (analog
  `reef-cloud.mjs:33-39`, `reef-relay.mjs:29-35`); Handler-Absicherung
  `reef-cloud-v2.mjs:865`.
- **Bewertung:**
  - `readStr()` ist durch `b.length` begrenzt — **keine Endlosschleife** möglich,
    auch ohne ein einziges NUL-Byte im Frame. Fehlende Terminatoren liefern leere
    Felder, kein Crash. Riesige Payloads erzeugen nur einen begrenzten
    `Buffer.from(slice)`; das eigentliche Risiko (Frame-Größe) ist mit dem Fix aus
    §5 durch `maxPayload` gedeckt.
  - `encodeFrame` baut Arrays per Spread — bei sehr großen Payloads wäre das
    langsam, aber alle Aufrufe nutzen servergenerierte, kleine Payloads.
  - In `reef-cloud-v2.mjs` sind alle `message`-Handler in try/catch gefasst
    (`:865`) — Exceptions einzelner Frames reißen den Prozess nicht um.
  - **Restrisiko:** `reef-cloud.mjs` und `reef-relay.mjs` haben **keinen**
    äußeren try/catch um die Message-Handler. Eine unerwartete Ausnahme würde als
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
  Join/Routing-Logik `:782-812`; Geräteregistrierung per ungeprüftem
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
- **`reef-relay.mjs` ausgehender Client (~:115):** eingehend kein `maxPayload`
  (ws-Default 100 MiB) — Gegenstelle ist die echte Cloud, kein reales Risiko
  (siehe Anmerkung in §5).
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
| `110e68c` | serial-Validierung an `/api/program` (GET+POST) | `reef-cloud-v2.mjs` |
| `f0bde3f` | Statischer Pfad-Guard mit Separator/Gleichheit | `reef-cloud-v2.mjs` |
| `74c7ce5` | Account-Key im Altgeräte-Login-Log maskiert | `reef-cloud-v2.mjs` |
| `fa64492` | `webReadBody` settle't bei stillem Client-Abbruch | `reef-cloud-v2.mjs` |

## Offene Empfehlungen (Owner-Entscheidungen)

1. **Auth für die JSON-API** (§2), mindestens für `/api/setup*` — dringlichste
   offene Entscheidung.
2. **CORS einschränken/entfernen** (§3) — hängt davon ab, ob externe lokale
   Tools die API cross-origin nutzen.
3. Optional: README-Hinweis zu Credentials in Logs/Dumps/Captures (§6),
   `chmod 600 reef-cloud-key.pem` für Altbestand prüfen (§6),
   try/catch-Wrapper in `reef-cloud.mjs`/`reef-relay.mjs` (§8).

## Nachtrag 03.08.2026 — Owner-Entscheidung: SSH-Passwort-Login bleibt

Das Pi-Audit (Live-System) hat festgestellt: SSH-Passwort-Authentifizierung
ist aktiv (`50-cloud-init.conf` schlägt das `no` aus `60-cloudimg-settings.conf`),
User `sven` hat NOPASSWD-sudo, beide `authorized_keys` sind leer, kein fail2ban —
ein brute-forcbares Passwort ist die einzige Barriere zwischen LAN und root.

**Owner-Entscheidung (03.08.2026): wird im Heim-LAN so belassen, als unkritisch
eingestuft.** Voraussetzung dieser Einordnung: Der Pi ist ausschließlich aus
dem eigenen LAN erreichbar — keine Port-Freigabe/Exposition des SSH-Ports (22)
ins Internet und kein Gast-WLAN mit unbekannten Clients. Sollte sich das
ändern (Router-Freigabe, unsichere Gäste/IoT-Segmente), ist die Entscheidung
neu zu bewerten; dann: `PasswordAuthentication no` + SSH-Key für `sven`,
alternativ fail2ban + NOPASSWD entfernen.

