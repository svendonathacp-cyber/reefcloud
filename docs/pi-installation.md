# reefcloud auf dem Raspberry Pi installieren

Diese Anleitung richtet reefcloud als lokalen Ersatz für die abgeschaltete
Reef-Factory-Cloud auf einem Raspberry Pi ein. Am Ende läuft der Server als
systemd-Dienst, startet bei jedem Boot automatisch und wird über den
Setup-Wizard (Port 8080) konfiguriert.

> **Hinweis:** Inoffizielles Community-Projekt. Nutzung auf eigene Gefahr,
> nur im eigenen Heimnetz.

## Voraussetzungen

- **Hardware:** Raspberry Pi 3, 4, 5 oder Zero 2 W (jeder Pi mit 64-bit-OS
  genügt; der Server braucht kaum Ressourcen).
- **Betriebssystem:** Raspberry Pi OS Lite, 64-bit, Debian bookworm
  (mit dem Raspberry Pi Imager auf die SD-Karte schreiben; WLAN, Benutzer
  und SSH lassen sich dort schon vorkonfigurieren).
- **Netzwerk:** LAN oder WLAN mit Internetzugang (für die Installation;
  danach reicht das Heimnetz).
- **DNS-Rewrite-Möglichkeit** im Heimnetz, z. B. AdGuard Home, Pi-hole oder
  eine entsprechende Router-Funktion — die Geräte müssen
  `api.reeffactory.com` auf den Pi auflösen.
- Zugriff per SSH oder direkt mit Tastatur/Monitor.

## Schnellstart

```bash
curl -fsSL https://raw.githubusercontent.com/svendonathacp-cyber/reefcloud/main/deploy/install.sh | sudo bash
```

> ⚠️ **Warnhinweis:** Skripte aus dem Internet sollte man grundsätzlich
> **vorher lesen**, bevor man sie mit root-Rechten ausführt. Sicherere
> Variante — erst herunterladen, ansehen, dann starten:
>
> ```bash
> curl -fsSL -o install.sh https://raw.githubusercontent.com/svendonathacp-cyber/reefcloud/main/deploy/install.sh
> less install.sh
> sudo bash install.sh
> ```

Das Skript ist **idempotent**: Es kann jederzeit erneut ausgeführt werden,
z. B. um auf eine neue Version zu aktualisieren (Installation = Update).

## Was das Skript tut

1. Prüft, ob es als root läuft (sonst Abbruch mit Hinweis auf `sudo`).
2. `apt update` und Installation von `git`, `curl` und `ca-certificates`.
3. **Node.js:** Prüft, ob Node ≥ 18 installiert ist. Falls nicht, wird
   Node.js 22 LTS über das offizielle NodeSource-Setup eingerichtet
   (mit klarer Log-Ausgabe, welcher Fall eingetreten ist).
4. Klont das Repository nach `/opt/reefcloud`. Ist es bereits vorhanden,
   wird mit `git pull --ff-only` aktualisiert (lokale Änderungen führen zu
   einer verständlichen Fehlermeldung statt zu Überschreiben).
5. `npm install --omit=dev` in `/opt/reefcloud` — das Web-UI
   (`webui/dist/`) ist bereits fertig im Repo enthalten, es findet **kein
   Build auf dem Pi** statt.
6. Setzt die **Zeitzone auf `Europe/Berlin`** (nur wenn sie abweicht).
   Wichtig, weil die Geräte ihre Uhrzeit vom Server beziehen.
7. Installiert die systemd-Unit `reef-cloud.service` nach
   `/etc/systemd/system/`, führt `daemon-reload` aus und startet den
   Dienst mit `enable --now` (Autostart bei jedem Boot).
8. Gibt zum Abschluss die LAN-IP(s) des Pi aus, den Link zum Setup-Wizard
   (`http://<ip>:8080`) und Hinweise zu DHCP-Reservierung und DNS-Rewrite.

## Danach: Ersteinrichtung

1. **Setup-Wizard öffnen:** `http://<pi-ip>:8080` im Browser aufrufen.
   Solange kein Tunnel konfiguriert ist, erscheint automatisch der Wizard.
   Er zeigt die LAN-IPs für den DNS-Rewrite an und schreibt die
   Konfiguration (`TUNNEL_URL`, `TUNNEL_TOKEN`, …) nach
   **`/boot/reef-cloud.env`**. Diese Datei enthält Secrets — sie bleibt
   lokal auf dem Pi und gehört niemals ins Git-Repo oder in ein Image.
2. **Feste IP vergeben:** Im Router eine **DHCP-Reservierung** für den Pi
   einrichten, damit er immer dieselbe IP bekommt. (Bewusst nicht Teil des
   Skripts — das ist Router-Sache und bei jedem Modell anders.)
3. **DNS-Rewrite anlegen:** In AdGuard Home (o. ä.)
   `api.reeffactory.com` → IP des Pi. Erst dadurch landen die Geräte und
   die App auf reefcloud statt auf der (toten) Hersteller-Cloud.
4. **Zertifikat aufs Handy:** Beim ersten Start erzeugt der Server
   automatisch ein selbst-signiertes CA-Zertifikat (10 Jahre gültig). Die
   öffentliche `.crt`-Datei auf dem Handy als CA installieren — die
   Hersteller-App validiert das Zertifikat, die Geräte-Firmware nicht.
5. **Geräte neu verbinden:** Geräte einmal stromlos machen; sie melden
   sich danach beim Pi an (Login und Reports laufen wie bei der
   Original-Cloud).

## Betrieb

| Befehl | Zweck |
|--------|-------|
| `systemctl status reef-cloud` | Dienst-Status anzeigen |
| `journalctl -u reef-cloud -f` | Logs live verfolgen |
| `sudo systemctl restart reef-cloud` | Dienst neu starten |
| `sudo bash install.sh` (erneut) | Aktualisieren auf die neueste Version |

Die Ports des Servers: **443 + 444** (TLS: App bzw. Geräte mit neuer
Firmware), **442 + 80** (unverschlüsselt: Altgeräte/Fallback), **8080**
(Web-UI/Setup-Wizard). Da 80/442/443/444 privilegierte Ports sind, läuft
der Dienst als root. In der Unit-Datei (`deploy/reef-cloud.service`) ist
kommentiert, wie man stattdessen mit `setcap` und `User=pi` arbeiten
könnte — diese Variante ist noch nicht auf echter Hardware abgenommen.

## Ausblick: fertiges Image

Aktuell ist der Installationsweg **bewusst das Skript** — kein fertiges
SD-Karten-Image. Ein vorkonfiguriertes Image (auf Basis von PiShrink, damit
es sich beim ersten Boot auf die SD-Kartengröße expandiert) folgt erst,
nachdem die Installation auf **echter Hardware** abgenommen wurde.

Grund: Ein Image würde ungetestete Annahmen zementieren (Partitionierung,
Boot-Konfiguration, WLAN-Vorkonfiguration, Dienstverhalten nach
Kaltstart). Solange niemand die komplette Kette auf einem realen Pi mit
realen Geräten durchgespielt hat, wäre ein Image ein Blindflug.

**Abnahme-Checkliste** (muss auf echter Hardware vollständig grün sein,
bevor ein Image gebaut wird):

- [ ] Frisches Pi OS Lite 64-bit → Skript läuft ohne manuelle Eingriffe durch
- [ ] **Geräte-Login:** Mindestens ein Gerät (idealerweise alte *und* neue
      Firmware) meldet sich nach Strom-Reset am Pi an
- [ ] **App-Login:** Hersteller-App verbindet sich (Port 443), Tankliste und
      Live-Status stimmen
- [ ] **Steuerung:** Ein Kommando aus der App kommt beim Gerät an
- [ ] **Tunnel:** Tunnel-Verbindung steht (falls konfiguriert), Status-Push
      und Steuerkommandos funktionieren
- [ ] **Capture:** Mitschnitt-Funktion (`setCapture`/`getCapture`)
      funktioniert über den Tunnel
- [ ] **Web-UI:** Port 8080 erreichbar, Setup-Wizard schreibt
      `/boot/reef-cloud.env` korrekt
- [ ] **Neustart-Festigkeit:** Nach `sudo reboot` (und nach Strom trennen)
      läuft der Dienst automatisch, Geräte verbinden sich ohne Eingriff neu
- [ ] **Zeitzone:** `timedatectl` zeigt `Europe/Berlin`, Geräte-Uhrzeit
      stimmt nach Login

Erst wenn diese Liste auf mindestens einem realen Pi mit realen
Reef-Factory-Geräten komplett abgehakt ist, wird ein PiShrink-basiertes
Image gebaut und hier dokumentiert.
