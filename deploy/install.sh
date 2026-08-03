#!/usr/bin/env bash
#
# reefcloud — Installationsskript für Raspberry Pi OS Lite (64-bit, bookworm)
#
# Idempotent: kann beliebig oft ausgeführt werden (Install = Update).
# Aufruf:
#   curl -fsSL https://raw.githubusercontent.com/svendonathacp-cyber/reefcloud/main/deploy/install.sh | sudo bash
# oder sicherer (erst lesen, dann ausführen):
#   curl -fsSL -o install.sh https://raw.githubusercontent.com/svendonathacp-cyber/reefcloud/main/deploy/install.sh
#   less install.sh && sudo bash install.sh
#
# Schalter:
#   -kimi / --kimi   installiert zusätzlich die Kimi Code CLI (npm, global;
#                    danach einmalig `kimi` starten und /login ausführen)
#
set -euo pipefail

REPO_URL="https://github.com/svendonathacp-cyber/reefcloud.git"
INSTALL_DIR="/opt/reefcloud"
SERVICE_NAME="reef-cloud.service"
TIMEZONE="Europe/Berlin"
NODE_MAJOR_MIN=18   # Mindestversion laut Projekt
NODE_MAJOR_LTS=22   # wird via NodeSource installiert, falls node fehlt/zu alt

INSTALL_KIMI=0
for arg in "$@"; do
  case "$arg" in
    -kimi|--kimi) INSTALL_KIMI=1 ;;
    -h|--help) echo "Aufruf: sudo bash install.sh [-kimi|--kimi]"; exit 0 ;;
    *) echo "Unbekannter Schalter: $arg (gültig: -kimi|--kimi)" >&2; exit 2 ;;
  esac
done

# ---------------------------------------------------------------- Logging ---
log()  { printf '\033[1;34m[reefcloud]\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m[ OK ]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[WARN]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[FEHLER]\033[0m %s\n' "$*" >&2; exit 1; }

# ------------------------------------------------------------- Root-Check ---
if [[ "${EUID}" -ne 0 ]]; then
  die "Dieses Skript muss als root laufen. Bitte mit 'sudo bash $0' starten."
fi

# ----------------------------------------------------- Selbst-Update-Falle ---
# Wird das Skript direkt aus dem Repo-Verzeichnis gestartet
# (sudo bash /opt/reefcloud/deploy/install.sh), wuerde der spaetere
# `git pull` genau diese Datei ueberschreiben, waehrend bash sie einliest.
# Deshalb: laufende Kopie nach mktemp verschieben und von dort neu starten.
# REEF_INSTALL_REEXEC verhindert eine Endlosschleife.
if [[ "${REEF_INSTALL_REEXEC:-0}" != "1" ]]; then
  script_path="$(readlink -f "$0" 2>/dev/null || echo "$0")"
  case "${script_path}" in
    "${INSTALL_DIR}"/*)
      tmp_copy="$(mktemp /tmp/reefcloud-install.XXXXXX.sh)"
      cp "${script_path}" "${tmp_copy}"
      chmod +x "${tmp_copy}"
      echo "[reefcloud] Skript liegt in ${INSTALL_DIR} — starte aus temporaerer Kopie neu (Selbst-Update-Schutz)."
      exec env REEF_INSTALL_REEXEC=1 bash "${tmp_copy}" "$@"
      ;;
  esac
fi

if [[ ! -f /etc/debian_version ]]; then
  warn "Kein Debian-System erkannt (/etc/debian_version fehlt) — Skript ist für Raspberry Pi OS gedacht, läuft aber weiter."
fi

# Temporaere Kopie (Selbst-Update-Schutz oben) nach Laufende aufraeumen.
if [[ "${REEF_INSTALL_REEXEC:-0}" == "1" ]]; then
  trap 'rm -f "$0" 2>/dev/null || true' EXIT
fi

log "Starte reefcloud-Installation nach ${INSTALL_DIR} …"

# ----------------------------------------------------------- apt-Basis ---
log "Aktualisiere Paketlisten (apt update) …"
apt-get update -qq

log "Installiere Basispakete (git, curl, ca-certificates) …"
apt-get install -y -qq git curl ca-certificates

# ------------------------------------------------------------------ Node ---
node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  local major
  major="$(node -v 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/')"
  [[ -n "${major}" && "${major}" -ge "${NODE_MAJOR_MIN}" ]]
}

if node_ok; then
  ok "Node.js $(node -v) ist bereits installiert (>= ${NODE_MAJOR_MIN})."
else
  if command -v node >/dev/null 2>&1; then
    warn "Gefundenes Node.js $(node -v) ist zu alt (< ${NODE_MAJOR_MIN}). Installiere Node.js ${NODE_MAJOR_LTS} LTS via NodeSource."
  else
    log "Node.js nicht gefunden. Installiere Node.js ${NODE_MAJOR_LTS} LTS via NodeSource …"
  fi
  # Das ist der offizielle, von NodeSource dokumentierte Installationsweg
  # (deb.nodesource.com) — die Warnung in der Doku, fremde Skripte vorher zu
  # lesen, gilt fuer dieses Install-Skript selbst; die NodeSource-Pipe ist
  # der vorgesehene Weg des Distributors. Alternativ manuell:
  # https://github.com/nodesource/distributions#debian-and-ubuntu-based-distributions
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR_LTS}.x" | bash -
  apt-get install -y -qq nodejs
  node_ok || die "Node.js-Installation fehlgeschlagen (gefunden: $(node -v 2>/dev/null || echo 'keins'))."
  ok "Node.js $(node -v) installiert."
fi

# ------------------------------------------------------------------ Repo ---
if [[ -d "${INSTALL_DIR}/.git" ]]; then
  log "Repository in ${INSTALL_DIR} vorhanden — aktualisiere (git pull --ff-only) …"
  git -C "${INSTALL_DIR}" fetch --quiet origin
  if ! git -C "${INSTALL_DIR}" pull --ff-only --quiet; then
    die "git pull --ff-only fehlgeschlagen — lokale Änderungen in ${INSTALL_DIR}? Bitte prüfen (git -C ${INSTALL_DIR} status)."
  fi
  ok "Repository aktualisiert ($(git -C "${INSTALL_DIR}" rev-parse --short HEAD))."
elif [[ -e "${INSTALL_DIR}" ]]; then
  die "${INSTALL_DIR} existiert, ist aber kein Git-Checkout. Bitte Verzeichnis sichern/entfernen und Skript erneut starten."
else
  log "Klone Repository nach ${INSTALL_DIR} …"
  git clone --quiet "${REPO_URL}" "${INSTALL_DIR}"
  ok "Repository geklont ($(git -C "${INSTALL_DIR}" rev-parse --short HEAD))."
fi

# ------------------------------------------------------------ npm-Pakete ---
log "Installiere Node-Abhängigkeiten (npm install --omit=dev) …"
log "Hinweis: Das Web-UI (webui/dist/) ist im Repo enthalten — kein Build nötig."
npm --prefix "${INSTALL_DIR}" install --omit=dev --no-audit --no-fund --loglevel=error
ok "Abhängigkeiten installiert."

# ------------------------------------------- Kimi Code CLI (optional, -kimi) ---
if [[ "${INSTALL_KIMI}" == "1" ]]; then
  log "Installiere Kimi Code CLI global via npm (-kimi) …"
  npm install -g @moonshot-ai/kimi-code --no-audit --no-fund --loglevel=error
  ok "Kimi Code CLI installiert ($(kimi --version 2>/dev/null || echo 'kimi')). Einmalig 'kimi' starten und /login ausführen."
fi

# ---------------------------------------------------------------- Zeitzone ---
# Wichtig: Die Geräte beziehen ihre Uhrzeit vom Server!
current_tz="$(timedatectl show -p Timezone --value 2>/dev/null || echo '')"
if [[ "${current_tz}" == "${TIMEZONE}" ]]; then
  ok "Zeitzone ist bereits ${TIMEZONE}."
else
  log "Setze Zeitzone von '${current_tz:-unbekannt}' auf ${TIMEZONE} (Geräte übernehmen die Server-Uhrzeit) …"
  timedatectl set-timezone "${TIMEZONE}"
  ok "Zeitzone gesetzt: ${TIMEZONE}."
fi

# --------------------------------------------------------------- systemd ---
log "Installiere systemd-Unit (${SERVICE_NAME}) …"
install -m 0644 "${INSTALL_DIR}/deploy/reef-cloud.service" "/etc/systemd/system/${SERVICE_NAME}"
systemctl daemon-reload
systemctl enable --now "${SERVICE_NAME}"
ok "Dienst ${SERVICE_NAME} aktiviert und gestartet."

# Kurzer Zustandscheck (kein harter Fehler — der Dienst erzeugt z. B. beim
# allerersten Start erst sein TLS-Zertifikat und kann einen Moment brauchen)
sleep 2
if systemctl is-active --quiet "${SERVICE_NAME}"; then
  ok "Dienst läuft. Logs: journalctl -u ${SERVICE_NAME} -f"
else
  warn "Dienst ist (noch) nicht aktiv. Status prüfen mit: systemctl status ${SERVICE_NAME}"
  warn "Logs ansehen mit:              journalctl -u ${SERVICE_NAME} -n 50 --no-pager"
fi

# ------------------------------------------------------------ Abschluss ---
lan_ips="$(hostname -I 2>/dev/null | tr -s ' ' | sed 's/^ //;s/ $//')"
first_ip="$(echo "${lan_ips}" | cut -d' ' -f1)"

echo
echo "==================================================================="
echo "  reefcloud ist installiert und läuft als Dienst (${SERVICE_NAME})."
echo "==================================================================="
echo
echo "  LAN-IP(s) dieses Pi: ${lan_ips:-<keine gefunden>}"
echo
echo "  Nächste Schritte:"
echo "  1) Setup-Wizard im Browser öffnen:"
for ip in ${lan_ips}; do
  echo "       http://${ip}:8080"
done
[[ -z "${lan_ips}" ]] && echo "       http://<pi-ip>:8080"
echo "     Der Wizard schreibt /boot/reef-cloud.env (bleibt lokal, nie ins Repo)."
echo "  2) Feste IP: DHCP-Reservierung für diesen Pi im Router einrichten"
echo "     (die Geräte finden die Cloud sonst nach IP-Wechsel nicht mehr)."
echo "  3) DNS-Rewrite in AdGuard Home (o. ä.) anlegen:"
echo "       api.reeffactory.com  ->  ${first_ip:-<pi-ip>}"
echo "     Der Wizard auf Port 8080 zeigt die passenden IPs ebenfalls an."
echo "  4) Zertifikat: Beim ersten Start erzeugt der Server ein selbst-signiertes"
echo "     CA-Zertifikat — die .crt auf dem Handy installieren (siehe Doku)."
if [[ "${INSTALL_KIMI}" == "1" ]]; then
  echo "  5) Kimi Code CLI: einmalig 'kimi' starten und /login ausführen."
fi
echo
echo "  Doku: docs/pi-installation.md im Repo bzw. auf GitHub."
echo
