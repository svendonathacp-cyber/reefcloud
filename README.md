# reefcloud — lokale Ersatz-Cloud für Reef-Factory-Geräte

Der Hersteller der Reef-Factory-Aquariumtechnik ist insolvent, die
Hersteller-Cloud ist abgeschaltet bzw. nicht mehr verlässlich erreichbar.
Ohne Cloud lassen sich die Geräte (Rückförderpumpe, Strömungspumpen,
Vliesfilter, LED-Beleuchtung, Dosierer, Sensoren …) weder einrichten noch
steuern.

Dieses Projekt ersetzt die Cloud **vollständig lokal**: Die Geräte merken
keinen Unterschied, die originale Hersteller-App funktioniert weiter, und
optional lassen sich Status und Steuerung über einen eigenen Web-Server
(Tunnel) von überall erreichen.

> **Hinweis:** Inoffizielles Community-Projekt, kein Bezug zum Hersteller.
> Nutzung auf eigene Gefahr, nur im eigenen Heimnetz.

## Architektur

```
Geräte ──ws/wss──► reef-cloud-v2 (dieses Repo) ◄──wss─── Hersteller-App (Handy)
                        │
                        └── optional: reef-tunnel ──wss──► eigener Web-Server
                              (Status + Steuerung von unterwegs)
```

`reef-cloud-v2.mjs` betreibt vier Listener:

| Port | TLS | Zweck |
|------|-----|-------|
| 444  | ja  | Geräte mit neuer Firmware (1.4.x/1.5.x), Pfad `/hardware32` |
| 443  | ja  | Hersteller-App, Pfad `/controler` |
| 442  | nein | Altgeräte (Firmware 1.0.0/1.1.0), Pfad `/hardware` |
| 80   | nein | Fallback |

- **Live-Routing:** Geräteadressierte Frames werden zwischen App und Gerät
  durchgereicht (Steuern aus der App funktioniert).
- **Replay:** Account-/Tank-Antworten (tankList, Interface, Login) kommen aus
  lokalen Mitschnitten (`dumps/`) bzw. werden dynamisch aus den live
  verbundenen Geräten generiert.
- **Auto-Registrierung:** Unbekannte Geräte werden beim Login automatisch im
  Tank-Modell registriert.
- **State-Pflege & Tunnel:** Reports der Geräte werden zu Snapshots gemergt
  und bei Änderung über `reef-tunnel.mjs` an einen eigenen Server gepusht;
  umgekehrt nimmt der Tunnel Steuerkommandos entgegen
  (`listDevices`, `command`, `rawCommand`, `setCapture`, `getCapture`).

## Protokoll (Kurzfassung)

WebSocket, Subprotokoll `reeffactory` (neu) bzw. `arduino` (alt). Jede
Nachricht ist ein Binär-Frame aus fünf NUL-terminierten Feldern (latin1):

```
[serial\0][class\0][method\0][extra\0][payload\0]
```

- **Login, neue FW:** `geConnect/login`, Payload JSON
  `{key, token, email, version}`. Der `key` (4 Zeichen) ist pro Gerätetyp
  konstant und stammt aus der Firmware; `token` ist account-weit.
  Antwort: `geReport/login` + `geSet/time` (die Geräte beziehen ihre Uhrzeit
  von der Cloud — Server-Zeitzone korrekt einstellen!).
- **Login, alte FW:** `user/login`, binärer Payload
  `email\0pass\0\0key\0version\0`.
- **Reports:** neue Geräte senden `<xx>Report/all` mit UTF-8-JSON
  (z. B. `bpReport`, `swReport`, `srReport`); Altgeräte senden binäre
  `<xx>Refresh/*`-Frames.
- **Steuerung:** `<xx>Set/*`, `<xx>Execute/*` mit JSON-Payload.

Die Type-Keys und der Account-Token sind **nicht Teil dieses Repos** — sie
lassen sich aus einem einzigen Mitschnitt des eigenen Geräte-Logins
extrahieren (siehe Quickstart).

## Quickstart

Voraussetzungen: Node.js ≥ 18, ein Host mit fester IP im Heimnetz, DNS-Rewrite-
Möglichkeit (z. B. AdGuard Home, Pi-hole, Router).

1. **Mitschnitt anfertigen** (einmalig, liefert `dumps/`): Phase-1-Logger
   `reef-cloud.mjs` starten, DNS-Rewrite auf diesen Host, Gerät stromlos
   machen → Login und Reports landen als Dateien in `dumps/`.
   ⚠️ Diese Dateien enthalten Account-Token und E-Mail — **niemals
   committen oder weitergeben** (steht deshalb in der .gitignore).
2. **Starten:** `npm install && node reef-cloud-v2.mjs`
   - Fehlt das TLS-Zertifikat, wird es beim Start **automatisch
     selbst-signiert erzeugt** (`reef-cloud-cert.pem` / `reef-cloud-key.pem`,
     CN/SAN `api.reeffactory.com`, CA, 10 Jahre). Die öffentliche `.crt`
     auf dem Handy als CA installieren (die App validiert, die
     Geräte-Firmware nicht).
3. **Ersteinrichtung:** `http://<host>:8080` öffnen — solange kein
   Tunnel-Token konfiguriert ist, erscheint automatisch der
   **Setup-Wizard** (LAN-IPs für den DNS-Rewrite, Tunnel-URL + Token mit
   Verbindungstest). Der Wizard schreibt `/boot/reef-cloud.env` (Pi) bzw.
   `.env` (sonst) und startet den Tunnel ohne Neustart.
4. **DNS-Rewrite:** `api.reeffactory.com` → IP dieses Hosts.
5. **Optional — Tunnel manuell konfigurieren:** `.env` mit
   `TUNNEL_URL=wss://<eigener-host>/...` und `TUNNEL_TOKEN=<secret>`
   anlegen (Datei bleibt lokal, siehe .gitignore). Protokoll siehe
   Kommentarkopf in `reef-tunnel.mjs`.

## Dateien

| Datei | Zweck |
|-------|-------|
| `reef-cloud-v2.mjs` | Produktiver Server (Fake-Cloud, Routing, State, Tunnel, Setup-API) |
| `reef-cert.mjs`      | TLS-Zertifikat beim Start prüfen bzw. automatisch erzeugen |
| `setup.html`         | Setup-Wizard für den Erststart (Port 8080, ohne Build) |
| `reef-tunnel.mjs`    | Ausgehender wss-Tunnel (Reconnect, Re-Announce, Kommandos) |
| `tanklist-lib.mjs`   | Parser/Generator für das tankList-Binärformat |
| `reef-cloud.mjs`     | Phase-1-Logger (Mitschnitte/`dumps/` erzeugen) |
| `reef-relay.mjs`     | Relay/Proxy-Werkzeug aus der Protokoll-Analyse |
| `tanklist-*.mjs`     | Analyse- und Test-Skripte für das tankList-Format |

## Sicherheit

Dieses Repo enthält **bewusst keine** Tokens, Keys, Zertifikate,
Mitschnitte, E-Mail-Adressen oder IP-Adressen. Die Regeln stehen in
[CONTRIBUTING.md](CONTRIBUTING.md) und gelten für jeden Commit.
Jede Installation erzeugt ihre eigenen Secrets und Mitschnitte lokal.
