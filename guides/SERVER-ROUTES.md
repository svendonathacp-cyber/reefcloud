# Server-Routen für `guides/`

Damit die Anleitungs-Seiten funktionieren, braucht der reef-cloud-Server folgende Routen:

## 1. Statische Auslieferung der Anleitungen

| Route | Verhalten |
|---|---|
| `GET /guides/` | liefert `guides/index.html` (Directory-Default) |
| `GET /guides/index.html` | liefert `guides/index.html` |
| `GET /guides/zertifikat.html` | liefert `guides/zertifikat.html` |
| `GET /guides/dns.html` | liefert `guides/dns.html` |

- Content-Type `text/html; charset=utf-8`
- Kein Caching bzw. kurzes `Cache-Control: no-cache` empfohlen (Seiten werden gepflegt/aktualisiert).
- Die Seiten sind komplett eigenständig (kein Framework, keine externen Assets — CSS/JS/SVG alles inline), es reicht ein simpler Static-File-Serve aus dem Repo-Verzeichnis `guides/`.

## 2. Zertifikats-Download

| Route | Verhalten |
|---|---|
| `GET /guides/reef-cloud-cert.crt` | Inhalt der Datei `reef-cloud-cert.pem` (das selbst-signierte CA-Zertifikat, das der Server auch für TLS nutzt) als **Download** ausliefern |

Headers:

```
Content-Type: application/x-pem-file
Content-Disposition: attachment; filename="reef-cloud-cert.crt"
```

- Der Dateiname in der Content-Disposition **muss auf `.crt` enden** — iOS/Safari und Android erkennen `.pem`-Downloads sonst nicht als installierbares Zertifikat.
- Quelle ist die vom Server beim Start erzeugte/verwendete `reef-cloud-cert.pem` (siehe `reef-cert.mjs`); es wird **nur das Zertifikat** ausgeliefert, niemals der private Schlüssel.

## 3. Bereits benötigt vom Live-Test (zur Info, keine neue Route)

Der „Fertig-Test" in `dns.html` nutzt bereits existierendes Verhalten:

| Endpunkt | Erwartung |
|---|---|
| `GET http://api.reeffactory.com/` (Port 80) | antwortet mit Body `{}` und Header `Access-Control-Allow-Origin: *` |
| `GET https://api.reeffactory.com/` (Port 443) | TLS mit dem selbst-signierten Zertifikat; antwortet ebenfalls lesbar (CORS-Header `*`), sobald das CA-Zertifikat auf dem Client installiert ist |

Der Browser-`fetch` in `dns.html` braucht dafür nur lesbare Antworten mit `Access-Control-Allow-Origin: *`; der HTTP-Status selbst ist egal (jeder Status zählt als „erreichbar").
