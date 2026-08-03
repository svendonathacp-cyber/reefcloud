# AGENTS.md — Arbeitsanleitung für Agenten-Sessions (Kimi & Co.)

Diese Datei wird von Agenten-CLIs (z. B. Kimi Code) beim Start geladen.
Sie beschreibt, wie man im reefcloud-Projekt sicher und effektiv arbeitet.

## Was das Projekt ist

Lokale Ersatz-Cloud für Reef-Factory-Aquariengeräte (Original-Cloud
abgeschaltet). Der Server `reef-cloud-v2.mjs` imitiert
`api.reeffactory.com` (per DNS-Rewrite im Heimnetz), spricht das
RF-Protokoll (WebSocket, 5-Felder-Frames) und zusätzlich Jebao-Pumpen
über Gizwits-LAN. Dazu gehört eine Web-UI (`webui/`, React, fertig
gebaut in `webui/dist/` — **dist wird mitcommittet**).

## Architektur-Kurzüberblick

- `reef-cloud-v2.mjs` — Hauptserver. Ports: **444** Geräte TLS (neue FW),
  **442** Altgeräte plain-WS, **443** RF-App (Replay + Live-Routing),
  **80** Onboarding/Zertifikat, **8080** Web-UI + API
- Module: `reef-jebao.mjs` (Gizwits-LAN), `reef-doser.mjs`, `reef-salinity.mjs`,
  `reef-onboard.mjs` (Binär-Parser Altgeräte), `reef-autolevel.mjs`
  (Ablaufschacht-Regelung), `reef-tunnel.mjs` (WS-Tunnel zu externem
  Server, z. B. WebOS), `reef-updater.mjs` (Auto-Update via git),
  `reef-cert.mjs` (TLS-Zertifikat, Auto-Generierung), `tanklist-lib.mjs`
- `reef-relay.mjs` — MITM-Mitschnitt-Werkzeug (Gerät/App ↔ echte Cloud)
- `setup.html` — Ersteinrichtungs-Wizard (eigenes i18n, Schlüssel
  `reefcloud.lang` wie die Haupt-UI)
- `deploy/install.sh` — Pi-Installation/Update (idempotent, `-kimi`
  installiert die Kimi Code CLI); Doku in `docs/`

## Befehle

```bash
node reef-cloud-v2.mjs        # Start (Windows/Linux)
node reef-jebao-test.mjs      # Tests laufen je Modul als <modul>-test.mjs
cd webui && npm run build     # nach UI-Änderungen: dist neu bauen + committen
```

## Fernwartungs-API (LAN, Port 8080)

Produktiv läuft der Server auf einem Raspberry Pi im Heimnetz des Owners
(IP nicht im Repo hinterlegt — ggf. beim Owner erfragen oder aus
`docs/pi-migration.md`-Notizen ableiten). Basis: `http://<pi-ip>:8080`.

| Endpunkt | Zweck |
|---|---|
| `GET /api/devices` | Alle Geräte mit Live-State |
| `POST /api/command` | `{"serial","action","params":{}}` — Gerät steuern |
| `GET /api/logs?lines=N&match=x` | Server-Log (N ≤ 2000, Filter optional) |
| `GET /api/update/status` · `POST /api/update/check` · `POST /api/update/install` | Updates (install = git pull + Selbstneustart via systemd) |
| `POST /api/server/restart` | Dienst-Neustart |
| `GET /api/settings` · `GET /api/setup/status` | Konfiguration (Token niemals sichtbar) |

Kein Auth — LAN-only. Keine neuen Endpunkte mit Secrets-Rückgabe.

## Laufzeitdateien (gitignored — NIE committen)

`*.pem` (TLS), `.env` (Tunnel-Token), `dumps/` (Mitschnitte mit Account-
Daten; nur die referenzierten Replay-Dateien sind getrackt),
`jebao.json`, `names.json`, `device-states.json`, `device-ips.json`,
`device-props.json`, `autolevel*.json`, `programs/`, `*.log`, `*.pcapng`.
Frischinstallationen laufen ohne sie (Zertifikat + States bauen sich neu
auf; für die App-Antworten dann `dumps/` vom Bestandssystem kopieren).

## Regeln für Agenten

1. **Repo ist öffentlich.** Vor jedem Push Secret-Scan (muss leer sein):
   ```bash
   git grep --cached -niE "400f041|3c63e29|feuersoftware|sven@|fg7h|T0Cd|NuQE|donath-home" \
     -- . ':!package-lock.json' ':!webui/package-lock.json' ':!webui/dist'
   ```
   Keine echten LAN-IPs, Zugangsdaten, Tokens oder E-Mail-Adressen committen.
2. Commits als `Sven Donath <svendonathacp-cyber@users.noreply.github.com>`
   (`git -c user.name=… -c user.email=…`), Push mit `GIT_TERMINAL_PROMPT=0`.
3. Vor Commit: betroffene `*-test.mjs` laufen lassen + `node --check`.
4. Diagnose-/Referenz-Artefakte (Probes, pcapng, Referenz-Repos,
   Onboard-Dumps) **nicht** ins Repo — sie bleiben im lokalen Workspace.
5. Hardware-Wahrheit schlägt Annahmen: Parser/Writes gegen das echte
   Gerät verifizieren (Probes aus dem Owner-LAN), nicht nur gegen Doku.
6. Keine Server-Starts auf den Produktiv-Ports aus Agenten-Worktrees;
   der Produktiv-Server gehört dem Pi.

## Geräte-Fallstricke (teuer erkauft)

- **Jebao (Gizwits-LAN):** Keepalive ist Ping `0x15`/Pong `0x16` (≤ 10 s
  Intervall, sonst trennt die Pumpe). Writes brauchen **attr_flags 8 B +
  attr_values 400 B** (über ALLE writables bis id 63) — gekürzte Writes
  ACKt die Pumpe (0x94), verwirft sie aber still. **Linkage = 2 (Slave)**
  lässt die Pumpe Modus-/Futter-Writes ignorieren → erst `Linkage=0`.
- **Level-Sensoren:** Zustandscodes, nicht Alarm-Flags auswerten;
  Details in `reef-onboard.mjs` + Historie im Log.
- **Level-Keeper:** `todayMl` ist Little-Endian (einzige LE-Stelle im
  Protokoll). Status-Frames sind 9 B.
- **Salinity Guardian:** 4-B-Frame = Temp/100; 51-B-Layout separat
  (`reef-salinity.mjs`).
- **Thermo Control:** Onboard-Web-UI nur im eigenen AP-Modus erreichbar.

## Doku-Index

- `docs/pi-installation.md` — Neuinstallation (fremde Nutzer)
- `docs/pi-migration.md` — Umzug Bestandsserver → Pi
- `docs/security-audit.md` — Audit-Ergebnisse
