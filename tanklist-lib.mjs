// tanklist-lib.mjs — Parser + Generator für refresh/tankList (reef-cloud)
// Schema (reverse-engineered aus dumps/0020, alle Offsets verifiziert):
//
//   u32BE tankCount
//   per Tank:
//     u16BE flags (=0)
//     latin1[2] icon ("S.")
//     utf16be name + u16-NUL
//     u32BE devCount
//     u32BE tankDbId
//     per Device:
//       utf16be name + u16-NUL
//       latin1[16] serial (fix, KEIN Terminator)
//       u8 online
//       u32BE unk1        (geräteabhängig, z.B. 1967/335/0/120)
//       u16BE unk2 (=0)
//       latin1[2] icon ("S.")
//       u32BE unk3 (=0)
//       u8 z0 (=0)
//       latin1 capCode + NUL   ("100100"/"115115"/"141141"/"110110")
//       u24BE unk4 (=0x0001e3)
//       u32BE unk5 (=0)
//       u32BE rowId (eindeutig pro Gerät)
//   Trailer:
//     u32BE memberCount (=1)
//     per Member: u16BE flags, u16BE dbId, utf16be email + u16-NUL, u8 role (=1=owner)
//     Padding: NUL-Bytes bis Frame-Ende (Original: 5223 B — replizieren wir exakt)

export function parseTankListPayload(p) {
  let off = 0;
  const u16s = (b, o) => {
    let e = o;
    while (e + 1 < b.length && !(b[e] === 0 && b[e + 1] === 0)) e += 2;
    return [Buffer.from(b.subarray(o, e)).swap16().toString('utf16le'), e + 2];
  };
  const z = (b, o) => { const e = b.indexOf(0, o); return [b.subarray(o, e).toString('latin1'), e + 1]; };

  const tankCount = p.readUInt32BE(off); off += 4;
  const tanks = [];
  for (let t = 0; t < tankCount; t++) {
    const flags = p.readUInt16BE(off); off += 2;
    const icon = p.subarray(off, off + 2).toString('latin1'); off += 2;
    const [name, o1] = u16s(p, off); off = o1;
    const devCount = p.readUInt32BE(off); off += 4;
    const tankDbId = p.readUInt32BE(off); off += 4;
    const devices = [];
    for (let d = 0; d < devCount; d++) {
      const [devName, o2] = u16s(p, off); off = o2;
      const serial = p.subarray(off, off + 16).toString('latin1'); off += 16;
      const online = p[off]; off += 1;
      const unk1 = p.readUInt32BE(off); off += 4;
      const unk2 = p.readUInt16BE(off); off += 2;
      const devIcon = p.subarray(off, off + 2).toString('latin1'); off += 2;
      const unk3 = p.readUInt32BE(off); off += 4;
      const z0 = p[off]; off += 1;
      const [capCode, o3] = z(p, off); off = o3;
      const unk4 = p.readUIntBE(off, 3); off += 3;
      const unk5 = p.readUInt32BE(off); off += 4;
      const rowId = p.readUInt32BE(off); off += 4;
      devices.push({ name: devName, serial, online, unk1, unk2, icon: devIcon, unk3, z0, capCode, unk4, unk5, rowId });
    }
    tanks.push({ flags, icon, name, tankDbId, devices });
  }
  // Trailer: Member-Liste + Padding — roh durchreichen (Account-Ebene, nicht gerätebezogen)
  const trailer = Buffer.from(p.subarray(off));
  return { tanks, trailer };
}

export function generateTankListPayload(model, { onlineSerials = null, paddingLen = null } = {}) {
  const parts = [];
  const u16be = (s) => {
    const b = Buffer.alloc(s.length * 2 + 2);
    for (let i = 0; i < s.length; i++) b.writeUInt16BE(s.charCodeAt(i), i * 2);
    return b;
  };
  const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32BE(v >>> 0); return b; };
  const u16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16BE(v); return b; };

  parts.push(u32(model.tanks.length));
  for (const tank of model.tanks) {
    parts.push(u16(tank.flags), Buffer.from(tank.icon, 'latin1'), u16be(tank.name));
    parts.push(u32(tank.devices.length), u32(tank.tankDbId));
    for (const d of tank.devices) {
      const online = onlineSerials ? (onlineSerials.has(d.serial) ? 1 : 0) : d.online;
      parts.push(u16be(d.name), Buffer.from(d.serial.padEnd(16).slice(0, 16), 'latin1'));
      const tail = Buffer.alloc(1 + 4 + 2 + 2 + 4 + 1);
      tail[0] = online;
      tail.writeUInt32BE(d.unk1 >>> 0, 1);
      tail.writeUInt16BE(d.unk2, 5);
      tail.write(d.icon, 7, 'latin1');
      tail.writeUInt32BE(d.unk3 >>> 0, 9);
      tail[13] = d.z0;
      const cap = Buffer.from(d.capCode + '\0', 'latin1');
      const unk4 = Buffer.alloc(3); unk4.writeUIntBE(d.unk4, 0, 3);
      parts.push(tail, cap, unk4, u32(d.unk5), u32(d.rowId));
    }
  }
  let trailer = model.trailer;
  if (paddingLen !== null) {
    // Padding-Länge neu: Original-Padding im Trailer ans Ende, ggf. anpassen
    trailer = Buffer.from(trailer);
  }
  parts.push(trailer);
  return Buffer.concat(parts);
}

// CapCode-/unk1-Defaults nach Gerätetyp (Serial-Präfix), für NEUE Geräte
export const TYPE_DEFAULTS = {
  RFSW: { capCode: '115115', unk1: 0 },
  RFBP: { capCode: '141141', unk1: 0 },
  RFSRS: { capCode: '110110', unk1: 0 },
  RFSG: { capCode: '110110', unk1: 0 },
  DEFAULT: { capCode: '100100', unk1: 0 },
};

// Typ-Katalog aus boardingPanel/getDeviceTypes (Dump 0063): Serial-Präfix (wifiName) → Anzeigename
export const TYPE_NAMES = {
  RFRB: 'Reef flare Bar 2', RFRF: 'Reef flare', RFLB: 'Reef Flare Bar', RFLX: 'Reef Flare XS',
  RFST: 'Smart tester', RFKH: 'kH keeper', RFDA: 'Dosing pump ATO', RFDC: 'Dosing pump CR',
  RFDQ: 'Dosing pump Pro X4', RFDS: 'Dosing pump Pro X1', RFDZ: 'Dosing pump X4', RFDX: 'Dosing pump X3',
  RFDP: 'Dosing pump', RFPP: 'Dosing pump Pro', RFDL: 'Dosing pump Large', RFTC: 'Thermo control',
  RFPS: 'Power switcher', RFLK: 'Level keeper', RFPA: 'Power Switcher X4', RFSW: 'Smart wave',
  RFBP: 'Base pump', RFSR: 'Smart roller', RFSF: 'Smart feeder', RFTV: 'Thermo view',
  RFSG: 'Salinity guardian', RFPM: 'pH meter', RFTM: 'TDS meter', RFLS: 'Level sensor',
};

export function newDeviceRecord(name, serial, rowId) {
  const t = TYPE_DEFAULTS[serial.slice(0, 4)] || TYPE_DEFAULTS[serial.slice(0, 5)] || TYPE_DEFAULTS.DEFAULT;
  const displayName = name || TYPE_NAMES[serial.slice(0, 4)] || 'Neues Gerät';
  return { name: displayName, serial, online: 1, unk1: t.unk1, unk2: 0, icon: 'S.', unk3: 0, z0: 0, capCode: t.capCode, unk4: 0x0001e3, unk5: 0, rowId };
}
