# Projekt-Regeln: Commits & Sicherheit

Diese Regeln gelten für **jeden** Beitrag an diesem Repo — auch (und gerade)
für die KI-Sessions, die am Projekt mitarbeiten.

## Commit-Disziplin

- **Jeder Change = ein Commit + Push.** Nach jeder abgeschlossenen Änderung
  wird sofort committet und auf `main` gepusht. Keine ungesicherten
  Arbeitsstände über Nacht.
- Commit-Messages auf Deutsch, kurz und sachlich (was + warum).

## Secret-Regel (vor JEDEM Commit prüfen!)

Es wird **nichts Sicherheitsrelevantes** committet. Konkret verboten:

- **Tokens & Keys** — Account-Token, Tunnel-Token, Geräte-Type-Keys,
  Session-IDs. Keine Ausnahmen, auch nicht in Kommentaren oder Doku.
- **Passwörter & Benutzernamen** — inkl. E-Mail-Adressen (die sind hier
  gleichzeitig der Login-Name).
- **IP-Adressen** — keine LAN- oder WAN-IPs, keine hostspezifischen Pfade
  mit Personenbezug. In Doku/Code immer Platzhalter (`<PI-IP>`, `<VPS-IP>`).
- **Kryptomaterial** — `*.pem`, `*.crt`, `.env` (siehe .gitignore).
- **Mitschnitte** — `dumps/`, `*.pcapng`, Captures. Sie enthalten zwangsläufig
  Account-Token und persönliche Daten und sind pro Installation **lokal neu
  zu erzeugen** (siehe README, Quickstart Schritt 1).

### Praktischer Check vor dem Commit

```bash
git diff --cached --name-only          # was wird committed?
grep -rniE "token|passwort|password|secret|@[a-z0-9.-]+\.[a-z]{2,}|192\.168\.|10\.[0-9]+\." \
  <staged-dateien>                     # nichts davon darf drin sein
```

Bei Unsicherheit: lieber eine Datei mehr in die .gitignore als ein Leak.
Git vergisst nichts — ein einmal committetes Secret ist öffentlich, auch
wenn man es später löscht.
