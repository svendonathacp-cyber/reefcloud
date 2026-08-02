// Zentrales Wörterbuch der reef-cloud-UI.
// `de` ist der kanonische Schlüsselraum; `en` muss exakt dieselben Schlüssel
// enthalten — tsc (strict) erzwingt die Parallelität über Record<MessageKey, string>.
// Platzhalter in Texten: {name} — wird von t() interpoliert.

export const de = {
  // App / Seitentitel
  'app.title': 'reef-cloud — Lokale Reef-Factory-Cloud',
  'app.subtitle': 'Lokale Reef-Factory-Cloud',

  // Sprachwahl
  'lang.choose': 'Sprache wählen · Choose your language',
  'lang.switchTooltip': 'Sprache wechseln (Deutsch/English)',

  // Kopfzeile
  'header.vpsConnected': 'VPS verbunden',
  'header.vpsDisconnected': 'VPS getrennt',
  'header.tunnelConnected': 'Tunnel zum WebOS-Server{host}: verbunden',
  'header.tunnelDisconnected': 'Tunnel zum WebOS-Server{host}: getrennt — Reconnect läuft',
  'header.capture': 'Capture',
  'header.online': '{online}/{total} online',

  // Seitenleiste / Navigation
  'nav.tankList': 'Aquarienliste',
  'nav.tank': 'Aquarium',
  'nav.dashboard': 'Dashboard',
  'nav.log': 'Protokoll',
  'nav.devices': 'Geräte',

  // Dashboard-Gruppen
  'groups.pumpsFilters': 'Pumpen & Filter',
  'groups.lighting': 'Beleuchtung',
  'groups.sensors': 'Sensoren & Technik',

  // Startseite
  'home.logMonitor': 'Protokoll-Monitor',
  'home.apiError': 'API nicht erreichbar ({error}) — läuft die reef-cloud-v2 mit Web-Modul auf Port 8080? Die Ansicht aktualisiert sich automatisch, sobald sie erreichbar ist.',
  'home.noDevices': 'Noch keine Geräte bekannt — sie erscheinen nach ihrem Login an der Cloud.',

  // Gerätefamilien
  'family.basepump': 'Rückförderpumpe',
  'family.wave': 'Strömungspumpe',
  'family.roller': 'Smart roller',
  'family.flare': 'Reef flare',
  'family.levelSensor': 'Level sensor',
  'family.salinity': 'Salinity guardian',
  'family.thermo': 'Thermo control',
  'family.doser': 'Doser',
  'family.level': 'Level keeper',
  'family.powerswitcher': 'Power switcher',
  'family.unknown': 'Gerät',

  // Allgemein
  'common.apply': 'Übernehmen',
  'common.cancel': 'Abbrechen',
  'common.error': 'Fehler: {msg}',
  'common.sent': '{label} gesendet',
  'common.mode': 'Modus',
  'common.off': 'Aus',
  'common.on': 'An',
  'common.auto': 'Automatik',

  // Relative Zeit
  'time.never': 'nie',
  'time.secondsAgo': 'vor {s} s',
  'time.minutesAgo': 'vor {m} min',
  'time.hoursAgo': 'vor {h} h',

  // Leistungsregler
  'speed.label': 'Stärke',
  'speed.sent': '{device}: Stärke {value} % gesendet',

  // Basepump
  'basepump.modeBadge': 'Modus: {mode}',
  'basepump.noErrors': 'keine Fehler',
  'basepump.display': 'Display {display}',
  'basepump.feeding': 'Fütterung',

  // Wave-Pumpe
  'wave.feedingActive': 'Fütterung läuft',
  'wave.normalOperation': 'Normalbetrieb',
  'wave.clock': 'Uhr',
  'wave.modeN': 'Modus {n}',

  // Wave-Modi
  'waveMode.1': 'Konstant',
  'waveMode.2': 'Puls',
  'waveMode.3': 'Sinus',
  'waveMode.4': 'Zufällig',

  // Smart roller (Vliesfilter)
  'roller.fleeceRemaining': 'Vlies verbleibend',
  'roller.metaLine': '{current} m von {start} m · Wechsel in ≈ {days} Tagen',
  'roller.usedToday': 'Heute verbraucht',
  'roller.avgPerDay': 'Ø pro Tag',
  'roller.feed': 'Vorschub',
  'roller.feedMm': 'Vorschub {mm} mm',
  'roller.newRoll': 'Neue Rolle',
  'roller.confirmNewRoll': 'Neue Vliesrolle wirklich einlernen?',
  'roller.modeOff': 'Modus Aus',
  'roller.modeAuto': 'Modus Automatik',

  // Reef flare (Karte)
  'flare.lightOn': 'Beleuchtung an',
  'flare.lightOff': 'Beleuchtung aus',
  'flare.ledTemp': 'LED {temp} °C',
  'flare.channelShort': 'K{n}',

  // Generischer Body
  'generic.noData': 'Noch keine Statusdaten empfangen.',
  'generic.entries': '[{n} Einträge]',
  'generic.moreValues': '… und {n} weitere Werte',

  // Detailansicht
  'detail.online': 'online',
  'detail.offline': 'offline',
  'detail.fleece': 'Vlies',
  'detail.replaceIn': 'Wechsel in',
  'detail.days': 'Tagen',
  'detail.today': 'Heute',
  'detail.temperature': 'Temperatur',
  'detail.status': 'Status',
  'detail.maxChannel': 'Kanal-Max',
  'detail.readonlyNote': 'Nur Anzeige — Steuerbefehle für diesen Gerätetyp sind noch nicht verifiziert.',
  'detail.firmware': 'Firmware {v}',
  'detail.firmwareUnknown': 'Firmware unbekannt',
  'detail.ipUnknown': 'IP unbekannt',
  'detail.lastSeen': 'zuletzt gesehen vor {s} s',

  // Wave-Zeitplan-Editor
  'waveEditor.sent': 'Zeitplan an die Pumpe gesendet',
  'waveEditor.power': 'Leistung',
  'waveEditor.minPower': 'Minimale Leistung',
  'waveEditor.maxPower': 'Maximale Leistung',
  'waveEditor.period': 'Periode',
  'waveEditor.blockFrom': '{mode} ab {time}',
  'waveEditor.starts': 'Beginnt',
  'waveEditor.tapToEdit': 'Block antippen zum Bearbeiten — Modus, Startzeit und Parameter je Block.',
  'waveEditor.block': 'Block',
  'waveEditor.sending': 'Sende…',

  // Flare-Kanäle
  'channel.1': 'UV',
  'channel.2': 'Violett',
  'channel.3': 'Indigo',
  'channel.4': 'Blau',
  'channel.5': 'Grün',
  'channel.6': 'Rot',
  'channel.7': 'Weiß',

  // Flare-Programm-Editor
  'flareEditor.defaultName': 'Mein Programm',
  'flareEditor.programs': 'Programme',
  'flareEditor.timerMode': 'Zeitschaltmodus',
  'flareEditor.powerOff': 'Ausschalten',
  'flareEditor.comingSoon': 'folgt',
  'flareEditor.namePlaceholder': 'Programmname',
  'flareEditor.intensity': 'Gesamtintensität',
  'flareEditor.sentToLamp': 'Programm an die Lampe gesendet',
  'flareEditor.sentDescription': 'Version {version} — die Lampe bestätigt den Empfang mit einem Programm-Re-Push.',
  'flareEditor.saved': 'Programm gespeichert',
  'flareEditor.savedOfflineDescription': 'Lampe gerade offline — nach dem nächsten Login der Lampe erneut speichern, um hochzuladen.',
  'flareEditor.saveFailed': 'Speichern fehlgeschlagen',
  'flareEditor.point': 'Punkt',
  'flareEditor.tapPoint': 'Punkt antippen zum Bearbeiten — horizontal ziehen = Uhrzeit, vertikal = Kanalwert.',
  'flareEditor.pointTooltip': '{channel} · {time} · {value} %',
  'flareEditor.addPoint': 'Punkt hinzufügen',
  'flareEditor.deletePoint': 'Punkt löschen',
  'flareEditor.saving': 'Speichere…',
  'flareEditor.ok': 'O.K.',
  'flareEditor.footnote': 'Beim Speichern wird das Programm per rfPrecise/update an die Lampe gesendet und anhand des Programm-Re-Pushs (Version + Inhalt) verifiziert. Das aktuelle Lampenprogramm lädt der Editor automatisch, solange keine eigene Variante gespeichert ist.',

  // Protokoll-Monitor
  'log.framesInBuffer': '{n} Frames im Puffer',
  'log.captureOff': 'Capture aus — oben rechts aktivieren',
  'log.empty': 'Keine Frames im Puffer.',
} as const;

export type MessageKey = keyof typeof de;

export const en: Record<MessageKey, string> = {
  'app.title': 'reef-cloud — Local Reef Factory Cloud',
  'app.subtitle': 'Local Reef Factory Cloud',

  'lang.choose': 'Choose your language · Sprache wählen',
  'lang.switchTooltip': 'Switch language (English/Deutsch)',

  'header.vpsConnected': 'VPS connected',
  'header.vpsDisconnected': 'VPS disconnected',
  'header.tunnelConnected': 'Tunnel to the WebOS server{host}: connected',
  'header.tunnelDisconnected': 'Tunnel to the WebOS server{host}: disconnected — reconnecting',
  'header.capture': 'Capture',
  'header.online': '{online}/{total} online',

  'nav.tankList': 'Tank list',
  'nav.tank': 'Tank',
  'nav.dashboard': 'Dashboard',
  'nav.log': 'Log',
  'nav.devices': 'Devices',

  'groups.pumpsFilters': 'Pumps & filters',
  'groups.lighting': 'Lighting',
  'groups.sensors': 'Sensors & equipment',

  'home.logMonitor': 'Log monitor',
  'home.apiError': 'API not reachable ({error}) — is reef-cloud-v2 running with the web module on port 8080? The view refreshes automatically once it is reachable.',
  'home.noDevices': 'No devices known yet — they appear after logging in to the cloud.',

  'family.basepump': 'Return pump',
  'family.wave': 'Wave pump',
  'family.roller': 'Smart roller',
  'family.flare': 'Reef flare',
  'family.levelSensor': 'Level sensor',
  'family.salinity': 'Salinity guardian',
  'family.thermo': 'Thermo control',
  'family.doser': 'Doser',
  'family.level': 'Level keeper',
  'family.powerswitcher': 'Power switcher',
  'family.unknown': 'Device',

  'common.apply': 'Apply',
  'common.cancel': 'Cancel',
  'common.error': 'Error: {msg}',
  'common.sent': '{label} sent',
  'common.mode': 'Mode',
  'common.off': 'Off',
  'common.on': 'On',
  'common.auto': 'Auto',

  'time.never': 'never',
  'time.secondsAgo': '{s} s ago',
  'time.minutesAgo': '{m} min ago',
  'time.hoursAgo': '{h} h ago',

  'speed.label': 'Power',
  'speed.sent': '{device}: Power {value} % sent',

  'basepump.modeBadge': 'Mode: {mode}',
  'basepump.noErrors': 'No errors',
  'basepump.display': 'Display {display}',
  'basepump.feeding': 'Feeding',

  'wave.feedingActive': 'Feeding in progress',
  'wave.normalOperation': 'Normal operation',
  'wave.clock': 'Clock',
  'wave.modeN': 'Mode {n}',

  'waveMode.1': 'Constant',
  'waveMode.2': 'Pulse',
  'waveMode.3': 'Sine',
  'waveMode.4': 'Random',

  'roller.fleeceRemaining': 'Fleece remaining',
  'roller.metaLine': '{current} m of {start} m · Replace in ≈ {days} days',
  'roller.usedToday': 'Used today',
  'roller.avgPerDay': 'Avg per day',
  'roller.feed': 'Feed',
  'roller.feedMm': 'Feed {mm} mm',
  'roller.newRoll': 'New roll',
  'roller.confirmNewRoll': 'Really register a new fleece roll?',
  'roller.modeOff': 'Mode off',
  'roller.modeAuto': 'Mode auto',

  'flare.lightOn': 'Light on',
  'flare.lightOff': 'Light off',
  'flare.ledTemp': 'LED {temp} °C',
  'flare.channelShort': 'CH{n}',

  'generic.noData': 'No status data received yet.',
  'generic.entries': '[{n} entries]',
  'generic.moreValues': '… and {n} more values',

  'detail.online': 'online',
  'detail.offline': 'offline',
  'detail.fleece': 'Fleece',
  'detail.replaceIn': 'Replace in',
  'detail.days': 'days',
  'detail.today': 'Today',
  'detail.temperature': 'Temperature',
  'detail.status': 'Status',
  'detail.maxChannel': 'Max channel',
  'detail.readonlyNote': 'Read-only — control commands for this device type are not verified yet.',
  'detail.firmware': 'Firmware {v}',
  'detail.firmwareUnknown': 'Firmware unknown',
  'detail.ipUnknown': 'IP unknown',
  'detail.lastSeen': 'last seen {s} s ago',

  'waveEditor.sent': 'Schedule sent to the pump',
  'waveEditor.power': 'Power',
  'waveEditor.minPower': 'Minimum power',
  'waveEditor.maxPower': 'Maximum power',
  'waveEditor.period': 'Period',
  'waveEditor.blockFrom': '{mode} from {time}',
  'waveEditor.starts': 'Starts',
  'waveEditor.tapToEdit': 'Tap a block to edit — mode, start time and parameters per block.',
  'waveEditor.block': 'Block',
  'waveEditor.sending': 'Sending…',

  'channel.1': 'UV',
  'channel.2': 'Violet',
  'channel.3': 'Indigo',
  'channel.4': 'Blue',
  'channel.5': 'Green',
  'channel.6': 'Red',
  'channel.7': 'White',

  'flareEditor.defaultName': 'My Program',
  'flareEditor.programs': 'Programs',
  'flareEditor.timerMode': 'Timer mode',
  'flareEditor.powerOff': 'Power off',
  'flareEditor.comingSoon': 'coming soon',
  'flareEditor.namePlaceholder': 'Program name',
  'flareEditor.intensity': 'Overall intensity',
  'flareEditor.sentToLamp': 'Program sent to the light',
  'flareEditor.sentDescription': 'Version {version} — the light acknowledges receipt with a program re-push.',
  'flareEditor.saved': 'Program saved',
  'flareEditor.savedOfflineDescription': 'Light is offline right now — save again after its next login to upload.',
  'flareEditor.saveFailed': 'Save failed',
  'flareEditor.point': 'Point',
  'flareEditor.tapPoint': 'Tap a point to edit — drag horizontally for the time, vertically for the channel value.',
  'flareEditor.pointTooltip': '{channel} · {time} · {value} %',
  'flareEditor.addPoint': 'Add point',
  'flareEditor.deletePoint': 'Delete point',
  'flareEditor.saving': 'Saving…',
  'flareEditor.ok': 'OK',
  'flareEditor.footnote': 'On save, the program is sent to the light via rfPrecise/update and verified using the program re-push (version + content). The editor automatically loads the current light program as long as no custom variant has been saved.',

  'log.framesInBuffer': '{n} frames in buffer',
  'log.captureOff': 'Capture off — enable it at the top right',
  'log.empty': 'No frames in buffer.',
};
