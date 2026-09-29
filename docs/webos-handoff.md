# WebOS-Tunnel: Schnittstelle und Inbetriebnahme

Stand: 29.09.2026. Die lokale Cloud ist der ausgehende WebSocket-Client.
Ziel und Token kommen ausschließlich aus der lokalen Konfiguration; diese
Dokumentation enthält keine produktiven Adressen oder Zugangsdaten.

## Konfiguration

`TUNNEL_URL=wss://<WEBOS-HOST>/api/reef/tunnel` und `TUNNEL_TOKEN` auf dem
Pi in der bestehenden Secret-Konfiguration setzen (`.env` im Installations-
verzeichnis oder `/boot/reef-cloud.env`). Alternativ den lokalen Setup-Wizard
verwenden. Den bestehenden Token vom WebOS-Server geschützt übertragen,
nicht in Chat, Logs oder Git ablegen. Die API gibt nur `hasToken` zurück.
Vor Aktivierung sicherstellen, dass keine alte NAS-Bridge denselben Token
verwendet: WebOS erlaubt nur eine Verbindung; Code 4000 bedeutet ersetzt.

## Unterstützter Vertrag

- Ausgehendes WSS mit `Authorization: Bearer <TUNNEL_TOKEN>`.
- Reconnect mit Backoff von 1 bis 60 Sekunden; nach erfolgreichem Connect
  beginnt der Backoff erneut bei einer Sekunde.
- Nach jedem `open` vollständiger Re-Announce aller bekannten Geräte.
  Offline-Events werden nicht aufgestaut: der aktuelle Snapshot ist maßgeblich.
- Events: `{type:"event", event:"device", data:<snapshot>}`. Der Snapshot
  enthält stabile `serial`, `family`, `online`, vollständigen zusammengeführten
  `state` und `lastSeen` in Unix-Millisekunden. Offline bleibt der letzte
  Geräte-Zeitstempel erhalten; Tunnel-Reconnect erfindet keinen neuen Messwert.
- Requests: `{id,type:"request",method,params}`; Antworten mit derselben `id`,
  `type:"response"` und entweder `ok:true,data` oder `ok:false,error`.
  Antworten bleiben an die Verbindung des Requests gebunden.
- Implementiert: `listDevices`, `command`, `rawCommand`, `setCapture`,
  `getCapture`. Unbekannte Methoden liefern eine Fehlerantwort.

## Noch offene Kompatibilität

Die WebOS-Übergabe nennt zusätzlich `probe`, `scan`, `netdiag`, `arp`.
Diese Methoden sind hier noch nicht implementiert. Für eine kompatible
Implementierung werden die Parameter und Antwortschemata aus der aktuellen
Referenz `reef-bridge/src/tunnel.js` benötigt. WLAN-Onboarding und Jebao-
Discovery sind keine belegten Ersatzimplementierungen für diese Methoden.

Die lokale Familie `jebao` ist in der übergebenen WebOS-Familienliste nicht
enthalten. Anzeige und Befehle dafür müssen auf WebOS-Seite abgestimmt werden;
eine Umbenennung zu `wave` würde allein noch keine Befehlskompatibilität schaffen.
WebOS erwartet Antworten binnen 10 Sekunden. Die Vertragstests bestätigen
Antwortformat und Korrelation, keine Laufzeitgarantie für echte Geräte.

## Abnahme

1. Lokal `/api/setup/status` prüfen: `hasToken:true`, richtige URL,
   `tunnelConnected:true`. `/api/devices` muss die erwarteten Geräte enthalten.
2. In der angemeldeten WebOS-Sitzung `/api/reef/status` und
   `/api/reef/devices` prüfen. Der Tunnel-Bearer ist kein REST-Login.
3. Nach Tunnel-Reconnect müssen alle Geräte ohne neue Telemetrie erscheinen.
   Den vollständigen Zustand prüfen, nicht nur den Verbindungsstatus.
4. Einen kontrollierten Offline-/Online-Wechsel beobachten und danach einen
   gefahrlosen unterstützten Request mit korrelierter Antwort prüfen.
5. Bei 401 Token/Header prüfen; bei 4000 die konkurrierende Instanz stoppen.
   Bei verbundenem Tunnel und leerer Liste Re-Announce und lokale Geräte prüfen.

Lokale Verifikation: `node reef-tunnel-test.mjs` (auch in `npm test`).
Die Tests simulieren Transport und Geräte, sie ersetzen keine Live-Abnahme.
