// reef-cert.mjs — TLS-Zertifikat für die Fake-Cloud sicherstellen.
// Fehlen reef-cloud-cert.pem / reef-cloud-key.pem, wird beim Start automatisch
// ein selbst-signiertes Zertifikat erzeugt — dieselben Eigenschaften wie das
// manuell gebaute Original (Phase 1, von den Geräten akzeptiert):
//   CN = api.reeffactory.com, SAN DNS:api.reeffactory.com,
//   BasicConstraints CA:TRUE (kritisch), RSA 2048, 10 Jahre gültig.
// So läuft der Erststart auf dem Pi ohne jedes Zertifikats-Gebastele.

import fs from 'node:fs';
import path from 'node:path';
import { X509Certificate } from 'node:crypto';
import selfsigned from 'selfsigned';

const CERT_FILE = 'reef-cloud-cert.pem';
const KEY_FILE = 'reef-cloud-key.pem';
const CN = 'api.reeffactory.com';
const DAYS = 3650; // 10 Jahre — IoT-Geräte, kein Rotationskonzept

export async function ensureCertificate(dir, log) {
  const certPath = path.join(dir, CERT_FILE);
  const keyPath = path.join(dir, KEY_FILE);

  let generated = false;
  if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) {
    log(`TLS-Zertifikat fehlt (${CERT_FILE}/${KEY_FILE}) — erzeuge selbst-signiertes Zertifikat …`);
    const pems = await selfsigned.generate(
      [{ name: 'commonName', value: CN }],
      {
        keySize: 2048,
        days: DAYS,
        algorithm: 'sha256',
        extensions: [
          { name: 'basicConstraints', cA: true, critical: true },
          { name: 'subjectAltName', altNames: [{ type: 2, value: CN }] }, // type 2 = dNSName
        ],
      },
    );
    fs.writeFileSync(certPath, pems.cert, { mode: 0o644 });
    fs.writeFileSync(keyPath, pems.private, { mode: 0o600 });
    generated = true;
    log(`TLS-Zertifikat erzeugt: ${certPath} (CN=${CN}, ${DAYS} Tage, RSA 2048)`);
  }

  const certPem = fs.readFileSync(certPath);
  const keyPem = fs.readFileSync(keyPath);
  let fingerprint256 = null;
  let notAfter = null;
  try {
    const x = new X509Certificate(certPem);
    fingerprint256 = x.fingerprint256;
    notAfter = x.validTo;
  } catch { /* nur Info */ }

  return { certPem, keyPem, info: { cn: CN, generated, fingerprint256, notAfter } };
}
