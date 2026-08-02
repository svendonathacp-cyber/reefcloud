// Isolierter Test der Onboarding-Scan-Logik (Parsing + Heuristik),
// OHNE einen Server zu starten. Aufruf:
//   node reef-onboarding-test.mjs          → Parser-Fixtures + Heuristik
//   node reef-onboarding-test.mjs --live   → zusätzlich echter Scan auf diesem Host
import { scanWifiNetworks, parseNetsh, parseNmcli, parseIwlist, looksLikeRfDevice } from './reef-onboarding.mjs';

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}`);
  if (!ok) {
    console.log(`      erwartet: ${JSON.stringify(expected)}`);
    console.log(`      erhalten: ${JSON.stringify(actual)}`);
    failures++;
  }
}

// --- netsh (deutsches Windows) ---
const netshDe = `
Name der Schnittstelle : WLAN
Momentan sind 3 Netzwerke sichtbar.

SSID 1 : Heimnetz
    Netzwerktyp            : Infrastruktur
    Authentifizierung      : WPA2-Personal
    Verschlüsselung        : CCMP
    BSSID 1                 : aa:bb:cc:dd:ee:ff
         Signal             : 82%
         Funktyp            : 802.11n
    BSSID 2                 : 11:22:33:44:55:66
         Signal             : 45%

SSID 2 : RFTC-Setup
    BSSID 1                 : 22:33:44:55:66:77
         Signal             : 91%

SSID 3 : ESP_12AB34
    BSSID 1                 : 33:44:55:66:77:88
         Signal             : 60%

SSID 4 : 
    BSSID 1                 : 44:55:66:77:88:99
         Signal             : 100%
`;
const netshParsed = parseNetsh(netshDe);
check('netsh: Anzahl SSIDs (verstecktes Netz mit leerer SSID übersprungen)', netshParsed.length, 3);
check('netsh: SSID 1 Name', netshParsed[0]?.ssid, 'Heimnetz');
check('netsh: SSID 1 max Signal über 2 BSSIDs', netshParsed[0]?.signal, 82);
check('netsh: SSID 2 Signal', netshParsed[1]?.signal, 91);

// --- nmcli (inkl. escaped Doppelpunkt in SSID) ---
const nmcliOut = `Heimnetz:75\nFirma\\:Intern:50\nreeffactory-setup:88\n:30\n`;
const nmParsed = parseNmcli(nmcliOut);
check('nmcli: Anzahl (leere SSID übersprungen)', nmParsed.length, 3);
check('nmcli: escaped Colon', nmParsed[1]?.ssid, 'Firma:Intern');
check('nmcli: Signal als Zahl', nmParsed[2]?.signal, 88);

// --- iwlist ---
const iwlistOut = `
wlan0     Scan completed :
          Cell 01 - Address: AA:BB:CC:DD:EE:FF
                    ESSID:"Heimnetz"
                    Quality=70/94  Signal level=-40 dBm
          Cell 02 - Address: 11:22:33:44:55:66
                    ESSID:"thermocontrol"
                    Signal level=-60 dBm
`;
const iwParsed = parseIwlist(iwlistOut);
check('iwlist: Anzahl', iwParsed.length, 2);
check('iwlist: Quality-Prozent', iwParsed[0]?.signal, Math.round((70 / 94) * 100));
check('iwlist: dBm-Fallback grob', iwParsed[1]?.signal, 80);

// --- Heuristik ---
check('Heuristik RFBP-AP', looksLikeRfDevice('RFBP-Setup'), true);
check('Heuristik reef klein', looksLikeRfDevice('reeffactory-ap'), true);
check('Heuristik Thermo Control', looksLikeRfDevice('ThermoControl-Setup'), true);
check('Heuristik ESP', looksLikeRfDevice('ESP_12AB34'), true);
check('Heuristik Heimnetz negativ', looksLikeRfDevice('Heimnetz'), false);
check('Heuristik leer negativ', looksLikeRfDevice(''), false);

if (process.argv.includes('--live')) {
  console.log('\n--- Live-Scan auf diesem Host ---');
  try {
    const networks = await scanWifiNetworks();
    console.log(`Gefunden: ${networks.length} Netze`);
    for (const n of networks) console.log(`  ${n.rfLike ? '★' : ' '} ${n.ssid}  (${n.signal ?? '?'} %)`);
  } catch (e) {
    console.log(`Scan-Fehler (auf LAN-Servern erwartbar): ${e.message}`);
  }
}

console.log(failures === 0 ? '\nAlle Tests bestanden.' : `\n${failures} Test(s) FEHLGESCHLAGEN.`);
process.exit(failures === 0 ? 0 : 1);
