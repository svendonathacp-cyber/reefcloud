# Pi-Migration — Umzug eines bestehenden reef-cloud-Servers auf den Pi

Diese Anleitung ist für den **Umzug**: reef-cloud läuft bereits (z. B. auf
einem Windows-PC) und soll dauerhaft auf einen Raspberry Pi wandern — mit
bestehendem Zertifikat, Gerätezuständen und Einstellungen.

Für die **Neuinstallation** (andere Nutzer, frisches Setup) siehe
[docs/pi-installation.md](pi-installation.md).

## 1. Feste IP für den Pi

DHCP-Reservierung im Router für die MAC des Pi einrichten — die
DNS-Umschreibung zeigt später auf diese IP.

## 2. reef-cloud auf dem Pi installieren

```bash
curl -fsSL https://raw.githubusercontent.com/svendonathacp-cyber/reefcloud/main/deploy/install.sh | sudo bash
```

Das Skript installiert Node.js 22 LTS, setzt die Zeitzone **Europe/Berlin**
(die Geräte beziehen ihre Uhrzeit von uns), klont nach `/opt/reefcloud`,
installiert die Abhängigkeiten und richtet den Dienst `reef-cloud.service`
ein — **und startet ihn sofort**. Das ist unkritisch: Ohne kopierte
Laufzeitdateien ist der Tunnel noch nicht konfiguriert, und die Geräte
bleiben am alten Server, weil die DNS-Umschreibung noch dorthin zeigt.

Wer das Skript vorher lesen will (empfohlen):

```bash
curl -fsSL -o install.sh https://raw.githubusercontent.com/svendonathacp-cyber/reefcloud/main/deploy/install.sh
less install.sh && sudo bash install.sh
```

## 3. Alten Server stoppen

reef-cloud auf dem bisherigen Rechner beenden. **Wichtig**, damit nie zwei
Server mit demselben Tunnel-Token online sind.

## 4. Laufzeitdateien übernehmen

Diese Dateien liegen absichtlich nicht im Repo (Secrets, Account-Daten,
Laufzeitzustand). Vom alten Server auf den Pi kopieren — Beispiel aus der
Git Bash auf Windows (erst ins Home, dann mit sudo an ihren Platz; der
Dienst läuft als root):

```bash
PI=pi@<PI-IP>
cd /c/Users/<user>/.../reef-cloud
scp reef-cloud-cert.pem reef-cloud-key.pem .env jebao.json \
    names.json device-states.json device-ips.json device-props.json \
    autolevel.json autolevel-history.json "$PI:~/"
scp -r dumps programs "$PI:~/"
ssh "$PI" 'sudo mv ~/reef-cloud-*.pem ~/.env ~/jebao.json ~/names.json \
    ~/device-*.json ~/autolevel*.json /opt/reefcloud/ && \
    sudo cp -r ~/dumps ~/programs /opt/reefcloud/'
sudo systemctl restart reef-cloud.service   # auf dem Pi
```

| Datei | Zweck | Folge, wenn sie fehlt |
|---|---|---|
| `reef-cloud-cert.pem` / `reef-cloud-key.pem` | TLS-Zertifikat | Das bei der Installation neu erzeugte Zertifikat bleibt aktiv — allen Clients (iPhone!) muss dann das **neue** Zertifikat bekannt gemacht werden |
| `dumps/` | Replay-Antworten für die RF-App | App bekommt auf einige Anfragen keine Antwort |
| `.env` | Tunnel-Token (WebOS) | Tunnel verbindet nicht (der Server liest auch `/boot/reef-cloud.env`; `.env` im Install-Verzeichnis ist der einfachste Weg) |
| `jebao.json` | Jebao-Pumpen (IPs) | Jebao-Geräte fehlen |
| `names.json` | Geräte-Spitznamen | Namen weg (Geräte funktionieren trotzdem) |
| `device-states.json`, `device-ips.json`, `device-props.json` | Letzte Zustände/Metadaten | Baut sich neu auf, kurz leere Karten |
| `autolevel.json`, `autolevel-history.json` | Schacht-Regelung + Historie | Einstellungen/Historie weg |
| `programs/` | Flare-Lichtkurven | Programme weg |

## 5. Umschalten

1. **DNS-Rewrite** (AdGuard Home): `api.reeffactory.com` → **IP des Pi**
2. Geräte einmal kurz stromlos machen (sonst warten sie ihr eigenes
   Reconnect-Intervall ab)

## 6. Abnahme-Checkliste

- [ ] `journalctl -u reef-cloud.service -f` zeigt Logins aller Geräte
      (444/442), keine TLS-Fehler
- [ ] Web-UI erreichbar: `http://<PI-IP>:8080` — alle Geräte mit Zustand
- [ ] Statusleiste: Tunnel „verbunden" (WebOS)
- [ ] Autolevel aktiv (Schacht-Regelung schreibt ins Log)
- [ ] Jebao-Pumpe online und steuerbar
- [ ] RF-App verbindet sich (soweit sie es aktuell tut)
- [ ] Zeit stimmt (Log: `geSet/time` mit Berlin-Zeit)
- [ ] Nach `sudo reboot` startet der Dienst von allein

## 7. Troubleshooting

- **`EADDRINUSE`**: Zweiter reef-cloud-Prozess aktiv (alter Server noch an?).
  `ss -tlnp | grep -E ':(80|443|442|444|8080)'`
- **Geräte melden TLS „certificate unknown"**: Es läuft ein frisch erzeugtes
  Zertifikat → alte `.pem`-Dateien nach `/opt/reefcloud/` kopieren und
  `sudo systemctl restart reef-cloud.service`.
- **Keine Geräte-Logins**: DNS-Rewrite prüfen (zeigt `api.reeffactory.com`
  auf die Pi-IP?), Gerät einmal stromlos machen.
- **Zeit falsch um 1–2 h**: `timedatectl` — muss `Europe/Berlin` sein.
- **Updates**: laufen über das eingebaute Auto-Update in den Einstellungen
  der Web-UI oder per `sudo bash /opt/reefcloud/deploy/install.sh` (das
  Skript ist idempotent und zieht per `git pull` nach).
