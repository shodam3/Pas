// Čtení, úprava a zápis souborů FIT + sloučení záznamu z hodinek s daty z pásu.
// Funguje v prohlížeči i v Node (module.exports).
(function (root) {
'use strict';

const FIT_EPOCH = 631065600; // 1989-12-31T00:00:00Z v unixových sekundách
const CRC_T = [0x0000, 0xCC01, 0xD801, 0x1400, 0xF001, 0x3C00, 0x2800, 0xE401, 0xA001, 0x6C00, 0x7800, 0xB401, 0x5000, 0x9C01, 0x8801, 0x4400];
function crc16(bytes, crc = 0, start = 0, end = bytes.length) {
  for (let i = start; i < end; i++) {
    const b = bytes[i]; let t;
    t = CRC_T[crc & 0xF]; crc = (crc >> 4) & 0x0FFF; crc = crc ^ t ^ CRC_T[b & 0xF];
    t = CRC_T[crc & 0xF]; crc = (crc >> 4) & 0x0FFF; crc = crc ^ t ^ CRC_T[(b >> 4) & 0xF];
  }
  return crc;
}

// základní typy: velikost, čtení, neplatná hodnota
const BT = {
  0x00: { s:1, k:'u', inv:0xFF }, 0x01: { s:1, k:'s', inv:0x7F }, 0x02: { s:1, k:'u', inv:0xFF },
  0x83: { s:2, k:'s', inv:0x7FFF }, 0x84: { s:2, k:'u', inv:0xFFFF }, 0x85: { s:4, k:'s', inv:0x7FFFFFFF },
  0x86: { s:4, k:'u', inv:0xFFFFFFFF }, 0x07: { s:1, k:'b' }, 0x88: { s:4, k:'f' }, 0x89: { s:8, k:'f' },
  0x0A: { s:1, k:'u', inv:0 }, 0x8B: { s:2, k:'u', inv:0 }, 0x8C: { s:4, k:'u', inv:0 }, 0x0D: { s:1, k:'b' },
  0x8E: { s:8, k:'b' }, 0x8F: { s:8, k:'b' }, 0x90: { s:8, k:'b' }
};
const MSG = { file_id:0, session:18, lap:19, record:20, event:21, device_info:23, activity:34 };

// ---------- čtení ----------
function decode(input) {
  const b = input instanceof Uint8Array ? input : new Uint8Array(input);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const hsize = b[0];
  if (String.fromCharCode(b[8], b[9], b[10], b[11]) !== '.FIT') throw new Error('Soubor není ve formátu FIT');
  const dataSize = dv.getUint32(4, true);
  const out = { protocol:b[1], profile:dv.getUint16(2, true), messages:[] };
  const locals = {}, pendingDef = {};
  let p = hsize, end = hsize + dataSize, lastTs = 0;
  while (p < end) {
    const h = b[p++];
    if (h & 0x80) { // komprimovaná časová značka
      const local = (h >> 5) & 0x3, off = h & 0x1F;
      const def = locals[local]; if (!def) throw new Error('Chybí definice');
      let ts = (lastTs & ~0x1F) + off; if (off < (lastTs & 0x1F)) ts += 0x20; lastTs = ts;
      const raw = b.slice(p, p + def.len); p += def.len;
      out.messages.push({ def, raw, cts:ts, local, emitDef:!!pendingDef[local] }); pendingDef[local] = false;
      continue;
    }
    const local = h & 0x0F;
    if (h & 0x40) { // definice
      const arch = b[p + 1], le = arch === 0;
      const global = le ? dv.getUint16(p + 2, true) : dv.getUint16(p + 2, false);
      const n = b[p + 4]; p += 5;
      const fields = []; let off = 0;
      for (let i = 0; i < n; i++) { fields.push({ num:b[p], size:b[p + 1], type:b[p + 2], off }); off += b[p + 1]; p += 3; }
      const devFields = [];
      if (h & 0x20) { const nd = b[p++]; for (let i = 0; i < nd; i++) { devFields.push({ num:b[p], size:b[p + 1], dev:b[p + 2], off }); off += b[p + 1]; p += 3; } }
      locals[local] = { global, arch, fields, devFields, len:off }; pendingDef[local] = true;
    } else {
      const def = locals[local]; if (!def) throw new Error('Chybí definice');
      const raw = b.slice(p, p + def.len); p += def.len;
      const m = { def, raw, local, emitDef:!!pendingDef[local] }; pendingDef[local] = false;
      const tsv = getField(m, 253); if (tsv != null) lastTs = tsv;
      out.messages.push(m);
    }
  }
  return out;
}

function fieldOf(def, num) { return def.fields.find(f => f.num === num); }
function getField(m, num) {
  const f = fieldOf(m.def, num); if (!f) return num === 253 && m.cts != null ? m.cts : null;
  const t = BT[f.type & 0x9F] || BT[f.type]; if (!t || t.k === 'b' || f.size !== t.s) return null;
  const dv = new DataView(m.raw.buffer, m.raw.byteOffset, m.raw.byteLength), le = m.def.arch === 0;
  let v;
  if (t.k === 'f') v = t.s === 4 ? dv.getFloat32(f.off, le) : dv.getFloat64(f.off, le);
  else if (t.s === 1) v = t.k === 's' ? dv.getInt8(f.off) : dv.getUint8(f.off);
  else if (t.s === 2) v = t.k === 's' ? dv.getInt16(f.off, le) : dv.getUint16(f.off, le);
  else v = t.k === 's' ? dv.getInt32(f.off, le) : dv.getUint32(f.off, le);
  if (t.inv !== undefined && v === t.inv) return null;
  return v;
}
function setField(m, num, v) {
  const f = fieldOf(m.def, num); if (!f) return false;
  const t = BT[f.type & 0x9F] || BT[f.type]; if (!t || t.k === 'b' || f.size !== t.s) return false;
  const dv = new DataView(m.raw.buffer, m.raw.byteOffset, m.raw.byteLength), le = m.def.arch === 0;
  if (v == null || !isFinite(v)) v = t.inv !== undefined ? t.inv : 0;
  else if (t.k !== 'f') { v = Math.round(v); const max = t.k === 's' ? 2 ** (t.s * 8 - 1) - 2 : 2 ** (t.s * 8) - 2; v = Math.max(t.k === 's' ? -max : 0, Math.min(max, v)); }
  if (t.k === 'f') t.s === 4 ? dv.setFloat32(f.off, v, le) : dv.setFloat64(f.off, v, le);
  else if (t.s === 1) t.k === 's' ? dv.setInt8(f.off, v) : dv.setUint8(f.off, v);
  else if (t.s === 2) t.k === 's' ? dv.setInt16(f.off, v, le) : dv.setUint16(f.off, v, le);
  else t.k === 's' ? dv.setInt32(f.off, v, le) : dv.setUint32(f.off, v, le);
  return true;
}
// přidá do zprávy pole, které v její definici chybí
const defCache = new Map();
function ensureField(m, num, size, type) {
  if (fieldOf(m.def, num)) return;
  const key = m.def; let map = defCache.get(key); if (!map) { map = new Map(); defCache.set(key, map); }
  let nd = map.get(num);
  if (!nd) {
    const fields = m.def.fields.map(f => ({ ...f })); const off = m.def.fields.reduce((a, f) => a + f.size, 0);
    fields.push({ num, size, type, off });
    const devFields = m.def.devFields.map(f => ({ ...f, off:f.off + size }));
    nd = { global:m.def.global, arch:m.def.arch, fields, devFields, len:m.def.len + size };
    map.set(num, nd);
  }
  const fixedLen = m.def.fields.reduce((a, f) => a + f.size, 0);
  const raw = new Uint8Array(nd.len);
  raw.set(m.raw.subarray(0, fixedLen), 0);
  raw.set(m.raw.subarray(fixedLen), fixedLen + size);
  m.def = nd; m.raw = raw; setField(m, num, null);
}
function cloneMsg(m) { return { def:m.def, raw:m.raw.slice() }; }

// ---------- zápis ----------
function encode(fit, opts = {}) {
  if (opts.preserve) return encodePreserve(fit);
  const chunks = []; let len = 0;
  const push = a => { chunks.push(a); len += a.length; };
  const bound = new Array(16).fill(null); let next = 0;
  const defKey = d => d.global + '|' + d.arch + '|' + d.fields.map(f => f.num + ':' + f.size + ':' + f.type).join(',') + '|' + d.devFields.map(f => f.num + ':' + f.size + ':' + f.dev).join(',');
  const keys = new Map();
  for (const m of fit.messages) {
    let k = keys.get(m.def); if (!k) { k = defKey(m.def); keys.set(m.def, k); }
    let local = bound.findIndex(x => x === k);
    if (local < 0) {
      local = next; next = (next + 1) % 16; bound[local] = k;
      const d = m.def, le = d.arch === 0, hasDev = d.devFields.length > 0;
      const a = new Uint8Array(6 + d.fields.length * 3 + (hasDev ? 1 + d.devFields.length * 3 : 0));
      a[0] = 0x40 | (hasDev ? 0x20 : 0) | local; a[1] = 0; a[2] = d.arch;
      new DataView(a.buffer).setUint16(3, d.global, le);
      a[5] = d.fields.length; let q = 6;
      d.fields.forEach(f => { a[q++] = f.num; a[q++] = f.size; a[q++] = f.type; });
      if (hasDev) { a[q++] = d.devFields.length; d.devFields.forEach(f => { a[q++] = f.num; a[q++] = f.size; a[q++] = f.dev; }); }
      push(a);
    }
    let raw = m.raw;
    if (m.cts != null && !fieldOf(m.def, 253)) throw new Error('Komprimované časové značky nejsou podporované');
    const a = new Uint8Array(1 + raw.length); a[0] = local; a.set(raw, 1); push(a);
  }
  const out = new Uint8Array(14 + len + 2);
  const dv = new DataView(out.buffer);
  out[0] = 14; out[1] = fit.protocol || 0x20; dv.setUint16(2, fit.profile || 2132, true); dv.setUint32(4, len, true);
  out.set([0x2E, 0x46, 0x49, 0x54], 8);
  dv.setUint16(12, crc16(out, 0, 0, 12), true);
  let p = 14; for (const c of chunks) { out.set(c, p); p += c.length; }
  dv.setUint16(p, crc16(out, 0, 0, p), true);
  return out;
}

// zápis se stejnými lokálními čísly a definicemi na stejných místech jako originál
function defBytes(d, local) {
  const le = d.arch === 0, hasDev = d.devFields.length > 0;
  const a = new Uint8Array(6 + d.fields.length * 3 + (hasDev ? 1 + d.devFields.length * 3 : 0));
  a[0] = 0x40 | (hasDev ? 0x20 : 0) | local; a[1] = 0; a[2] = d.arch;
  new DataView(a.buffer).setUint16(3, d.global, le);
  a[5] = d.fields.length; let q = 6;
  d.fields.forEach(f => { a[q++] = f.num; a[q++] = f.size; a[q++] = f.type; });
  if (hasDev) { a[q++] = d.devFields.length; d.devFields.forEach(f => { a[q++] = f.num; a[q++] = f.size; a[q++] = f.dev; }); }
  return a;
}
function encodePreserve(fit) {
  const chunks = []; let len = 0; const bound = {};
  const push = a => { chunks.push(a); len += a.length; };
  for (const m of fit.messages) {
    const local = m.local;
    if (m.emitDef || bound[local] !== m.def) { push(defBytes(m.def, local)); bound[local] = m.def; }
    if (m.cts != null && !fieldOf(m.def, 253)) {
      const a = new Uint8Array(1 + m.raw.length); a[0] = 0x80 | ((local & 3) << 5) | (m.cts & 0x1F); a.set(m.raw, 1); push(a);
    } else { const a = new Uint8Array(1 + m.raw.length); a[0] = local; a.set(m.raw, 1); push(a); }
  }
  const out = new Uint8Array(14 + len + 2), dv = new DataView(out.buffer);
  out[0] = 14; out[1] = fit.protocol || 0x20; dv.setUint16(2, fit.profile || 2132, true); dv.setUint32(4, len, true);
  out.set([0x2E, 0x46, 0x49, 0x54], 8);
  dv.setUint16(12, crc16(out, 0, 0, 12), true);
  let p = 14; for (const c of chunks) { out.set(c, p); p += c.length; }
  dv.setUint16(p, crc16(out, 0, 0, p), true);
  return out;
}

// ---------- sloučení ----------
// samples: [[ms, rychlost km/h, vzdálenost m, sklon %, tep, pauza 0/1, index úseku], ...]
function merge(watchBytes, samples, opts = {}) {
  const fit = decode(watchBytes);
  const P = !!opts.preserve;   // zachovat přesně strukturu originálu (jen změnit hodnoty)
  const msgs = fit.messages;
  const recs = msgs.filter(m => m.def.global === MSG.record);
  if (recs.length < 10) throw new Error('Soubor z hodinek neobsahuje záznam běhu');
  if (!samples || samples.length < 10) throw new Error('Záznam z pásu je prázdný');
  // pás hlásí vzdálenost jen po 10 m – vzdálenost proto počítáme z rychlosti (lichoběžníkově)
  if (opts.distFromSpeed !== false) {
    let acc = 0;
    samples = samples.map((s, i) => {
      if (i) { const p = samples[i - 1], dt = Math.max(0, Math.min(5, (s[0] - p[0]) / 1000)); acc += (p[1] + s[1]) / 2 / 3.6 * dt; }
      const c = s.slice(); c[2] = acc; return c;
    });
  }
  const unix = m => getField(m, 253) + FIT_EPOCH;

  // 1) časový posun hodin – podle průběhu tepu, nebo jak ho zvolil uživatel
  const al = alignRecs(recs, samples);
  const offset = opts.offset != null ? opts.offset : al.offset;
  const bestErr = al.error, bestN = al.points;

  // 2) data z pásu v čase hodinek (interpolace po sekundách)
  const T = samples.map(s => s[0] / 1000 - offset);
  function at(t) {
    if (t < T[0]) return { dist:samples[0][2], speed:0, inc:samples[0][3], step:samples[0][6], out:true };
    if (t >= T[T.length - 1]) { const s = samples[samples.length - 1]; return { dist:s[2], speed:0, inc:s[3], step:s[6], out:true }; }
    let lo = 0, hi = T.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (T[mid] <= t) lo = mid; else hi = mid; }
    const a = samples[lo], b = samples[hi], k = (t - T[lo]) / ((T[hi] - T[lo]) || 1);
    return { dist:a[2] + (b[2] - a[2]) * k, speed:a[5] ? 0 : a[1] + (b[1] - a[1]) * k, inc:a[3], step:a[6], out:false };
  }
  const t0 = unix(recs[0]);
  const base = at(t0).dist;

  // 3) přepsání záznamů
  let prevD = 0, alt = 0, prevT = t0, ascent = 0;
  const pts = [];
  for (const m of recs) {
    const t = unix(m), x = at(t);
    let d = Math.max(prevD, x.dist - base);
    alt += (d - prevD) * (x.inc / 100);
    if (d > prevD) ascent += Math.max(0, (d - prevD) * x.inc / 100);
    if (!P) { ensureField(m, 6, 2, 0x84); ensureField(m, 2, 2, 0x84); ensureField(m, 9, 2, 0x83); }
    setField(m, 5, d * 100);
    setField(m, 9, x.inc * 100);   // sklon v % × 100 (jen pokud pole existuje)
    setField(m, 6, x.speed / 3.6 * 1000);
    setField(m, 2, (alt + 500) * 5);
    pts.push({ t, d, v:x.speed / 3.6, hr:getField(m, 3), cad:getField(m, 4), step:x.step, alt, inc:x.inc, dt:Math.max(0, t - prevT) });
    prevD = d; prevT = t;
  }

  // průměrný sklon vážený uběhnutou vzdáleností
  function avgGrade(list) {
    let sd = 0, sg = 0;
    for (let j = 1; j < list.length; j++) { const dd = list[j].d - list[j - 1].d; sd += dd; sg += dd * list[j].inc; }
    return sd > 0 ? sg / sd : 0;
  }

  // pauzy hodinek (timer stop → start)
  const evs = msgs.filter(m => m.def.global === MSG.event && getField(m, 0) === 0).map(m => ({ t:unix(m), type:getField(m, 1) }));
  const pauses = []; let stopAt = null;
  evs.forEach(e => { if (e.type === 1 || e.type === 4) stopAt = e.t; else if (e.type === 0 && stopAt != null) { pauses.push([stopAt, e.t]); stopAt = null; } });
  const pausedIn = (a, b) => pauses.reduce((s, [x, y]) => s + Math.max(0, Math.min(b, y) - Math.max(a, x)), 0);

  // 4) okruhy: podle úseků tréninku (nebo po 1 km, když úseky chybí)
  const oldLaps = msgs.filter(m => m.def.global === MSG.lap);
  const tEnd = pts[pts.length - 1].t;
  const bounds = [t0];
  const useSteps = !P && opts.laps !== 'km' && samples.some(s => s[6] > 0);
  if (useSteps) {
    for (let i = 1; i < samples.length; i++) if (samples[i][6] !== samples[i - 1][6]) { const t = Math.round(T[i]); if (t > bounds[bounds.length - 1] + 5 && t < tEnd - 5) bounds.push(t); }
  } else {
    let k = 1; for (const p of pts) if (p.d >= k * 1000) { if (p.t < tEnd - 5) bounds.push(p.t); k++; }
  }
  bounds.push(tEnd);
  const newLaps = [];
  if (oldLaps.length) {
    for (let i = 0; i < bounds.length - 1; i++) {
      const a = bounds[i], b = bounds[i + 1];
      const seg = pts.filter(p => p.t > a && p.t <= b);
      const all = pts.filter(p => p.t >= a && p.t <= b);
      if (!all.length) continue;
      const dA = all[0].d, dB = all[all.length - 1].d, dist = Math.max(0, dB - dA);
      const elapsed = b - a, timer = Math.max(0, elapsed - pausedIn(a, b));
      const hrs = all.map(p => p.hr).filter(Boolean), cads = all.map(p => p.cad).filter(Boolean);
      const strides = seg.reduce((s, p) => s + (p.cad || 0) / 60 * p.dt, 0);
      let up = 0, down = 0; for (let j = 1; j < all.length; j++) { const dd = all[j].alt - all[j - 1].alt; if (dd > 0) up += dd; else down -= dd; }
      const src = oldLaps[Math.min(i, oldLaps.length - 1)];
      const L = P && i < oldLaps.length ? src : { ...cloneMsg(src), local:src.local, emitDef:false };
      const inner0 = pts.filter(p => p.t >= a && p.t < b);
      if (!P) { ensureField(L, 45, 2, 0x83); ensureField(L, 48, 2, 0x83); }
      setField(L, 45, avgGrade(all) * 100); setField(L, 48, Math.max(0, ...(inner0.length ? inner0 : all).map(p => p.inc)) * 100);
      setField(L, 254, newLaps.length); setField(L, 253, b - FIT_EPOCH); setField(L, 2, a - FIT_EPOCH);
      setField(L, 7, elapsed * 1000); setField(L, 8, timer * 1000); setField(L, 9, dist * 100);
      setField(L, 13, timer ? dist / timer * 1000 : 0); const inner = pts.filter(p => p.t >= a && p.t < b);
      setField(L, 14, Math.max(0, ...(inner.length ? inner : all).map(p => p.v)) * 1000);
      if (hrs.length) { setField(L, 15, hrs.reduce((s, x) => s + x, 0) / hrs.length); setField(L, 16, Math.max(...hrs)); setField(L, 63, Math.min(...hrs)); }
      if (cads.length) { setField(L, 17, cads.reduce((s, x) => s + x, 0) / cads.length); setField(L, 18, Math.max(...cads)); }
      setField(L, 120, strides ? dist / strides / 2 * 10000 : null);   // mm × 10
      setField(L, 21, up); setField(L, 22, down);
      newLaps.push(L);
    }
  }

  // součet časů okruhů srovnat s časem celého běhu (hodinky měří i zlomky sekund)
  const S0 = msgs.find(m => m.def.global === MSG.session);
  if (S0 && newLaps.length) {
    const sumT = newLaps.reduce((a, L) => a + (getField(L, 8) || 0), 0), sumE = newLaps.reduce((a, L) => a + (getField(L, 7) || 0), 0);
    const L = newLaps[newLaps.length - 1], dT = (getField(S0, 8) || sumT) - sumT, dE = (getField(S0, 7) || sumE) - sumE;
    if (Math.abs(dT) < 5000) { setField(L, 8, getField(L, 8) + dT); const t = getField(L, 8) / 1000; setField(L, 13, t ? (getField(L, 9) / 100) / t * 1000 : 0); }
    if (Math.abs(dE) < 5000) setField(L, 7, getField(L, 7) + dE);
  }

  // 5) souhrn běhu
  const totalD = pts[pts.length - 1].d;
  msgs.filter(m => m.def.global === MSG.session).forEach(S => {
    const timer = (getField(S, 8) || 0) / 1000;
    setField(S, 9, totalD * 100);
    setField(S, 14, timer ? totalD / timer * 1000 : 0);
    setField(S, 15, Math.max(...pts.map(p => p.v)) * 1000);
    setField(S, 22, ascent); setField(S, 23, 0);
    if (!P) { ensureField(S, 52, 2, 0x83); ensureField(S, 55, 2, 0x83); }
    setField(S, 52, avgGrade(pts) * 100); setField(S, 55, Math.max(0, ...pts.map(p => p.inc)) * 100);
    const cyc = getField(S, 10); if (cyc) setField(S, 134, totalD / cyc / 2 * 10000);   // mm × 10
  });

  // nahradit staré okruhy novými na stejném místě
  if (oldLaps.length) {
    const first = msgs.indexOf(oldLaps[0]);
    const rest = msgs.filter(m => m.def.global !== MSG.lap);
    const before = msgs.slice(0, first).filter(m => m.def.global !== MSG.lap).length;
    if (P && newLaps.length) newLaps[0].emitDef = oldLaps[0].emitDef;
    rest.splice(before, 0, ...newLaps);
    fit.messages = rest;
  }
  const bytes = encode(fit, { preserve:P });
  return {
    bytes, offset, hrMatch:bestN ? { error:bestErr, points:bestN } : null,
    stats:{ distance:totalD, ascent, laps:newLaps.length, start:new Date(t0 * 1000), end:new Date(tEnd * 1000),
            covered:samples[0][0] / 1000 - offset <= t0 + 120 && samples[samples.length - 1][0] / 1000 - offset >= tEnd - 120 }
  };
}

// Sladění hodin hodinek a telefonu podle tepu (tep z hodinek je v obou záznamech).
// Hledá posun v rozsahu ±range s. Nejednoznačné = stejně dobře (do +0,5 tepu) sedí posuny
// rozprostřené přes víc než 6 s – pak má rozhodnout uživatel.
// HR_WARN: průměrná odchylka tepu (tepy/min), od které se aplikace ptá, zda pokračovat.
const HR_WARN = 1;
const ALIGN_RANGE = 30, ALIGN_MIN_POINTS = 60, ALIGN_TOL = 0.5, ALIGN_SPREAD = 6;
function alignRecs(recs, samples, range = ALIGN_RANGE) {
  const wHr = new Map(); recs.forEach(m => { const h = getField(m, 3), t = getField(m, 253); if (h && t != null) wHr.set(t + FIT_EPOCH, h); });
  const tHr = new Map(); samples.forEach(s => { if (s[4]) tHr.set(Math.round(s[0] / 1000), s[4]); });
  const tried = [];
  for (let off = -range; off <= range; off++) {
    let sum = 0, n = 0;
    for (const [t, h] of wHr) { const x = tHr.get(t + off); if (x) { sum += Math.abs(x - h); n++; } }
    if (n >= ALIGN_MIN_POINTS) tried.push({ off, err:sum / n, n });
  }
  if (!tried.length) return { offset:0, error:null, points:0, ambiguous:false, matched:false, range };
  let best = tried[0];
  for (const t of tried) if (t.err < best.err || (t.err === best.err && Math.abs(t.off) < Math.abs(best.off))) best = t;
  const good = tried.filter(t => t.err <= best.err + ALIGN_TOL).map(t => t.off);
  const lo = Math.min(...good), hi = Math.max(...good);
  return { offset:best.off, error:best.err, points:best.n, ambiguous:hi - lo > ALIGN_SPREAD, matched:true, from:lo, to:hi, range,
           errorAt:off => { const t = tried.find(x => x.off === off); return t ? t.err : null; } };
}
function align(watchBytes, samples) {
  const fit = decode(watchBytes);
  return alignRecs(fit.messages.filter(m => m.def.global === MSG.record), samples);
}

// začátek a konec běhu v souboru z hodinek (pro výběr odpovídajícího záznamu z pásu)
function summary(watchBytes) {
  const fit = decode(watchBytes);
  const recs = fit.messages.filter(m => m.def.global === MSG.record);
  const S = fit.messages.find(m => m.def.global === MSG.session);
  const fid = fit.messages.find(m => m.def.global === MSG.file_id);
  return {
    start:new Date((getField(recs[0], 253) + FIT_EPOCH) * 1000),
    end:new Date((getField(recs[recs.length - 1], 253) + FIT_EPOCH) * 1000),
    distance:S ? (getField(S, 9) || 0) / 100 : null,
    manufacturer:fid ? getField(fid, 1) : null
  };
}

const api = { HR_WARN, decode, encode, merge, summary, align, getField, setField, crc16, FIT_EPOCH };
if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.FIT = api;
})(typeof window !== 'undefined' ? window : globalThis);
// Pás – oprava běhu v Corosu (krok 2). Spouští se jako záložka na stránce Training Hubu.
// Postup: přihlášení stránky → poslední běh na pásu → záznam z pásu na GitHubu → stáhnout FIT →
// uložit originál na GitHub → opravit → nahrát → přejmenovat → označit záznam → potvrzené smazání originálu.
// Postup nahrávání převzat z open-source knihoven Pinta365/coros a NYT87/coros-connect (MIT).
(async () => {
  'use strict';
  const NAME_FIXED = 'Běh uvnitř - upraveno';
  const FIT = window.FIT;
  const ID = 'pas-coros-panel';
  const old = document.getElementById(ID); if (old) old.remove();
  const box = document.createElement('div'); box.id = ID;
  box.style.cssText = 'position:fixed;left:8px;right:8px;top:8px;bottom:8px;z-index:2147483647;background:#fff;color:#111;font:14px/1.45 system-ui,sans-serif;border:2px solid #0b6bcb;border-radius:12px;padding:12px;overflow:auto;box-shadow:0 4px 24px rgba(0,0,0,.35)';
  box.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px"><b>Pás – oprava běhu</b><button id="pcX" style="font:inherit;padding:6px 12px">Zavřít</button></div><div id="pcBody" style="margin-top:8px"></div>';
  document.body.appendChild(box);
  box.querySelector('#pcX').onclick = () => box.remove();
  const body = box.querySelector('#pcBody');
  const OK = '#127a3e', BAD = '#b42318', MUTED = '#667085';
  const L = (t, c) => { const d = document.createElement('div'); d.textContent = t; if (c) d.style.color = c; d.style.whiteSpace = 'pre-wrap'; body.appendChild(d); box.scrollTop = box.scrollHeight; return d; };
  const fmt = ms => new Date(ms).toLocaleString('cs-CZ', { day:'numeric', month:'numeric', year:'numeric', hour:'2-digit', minute:'2-digit' });
  const fmtS = ms => new Date(ms).toLocaleString('cs-CZ', { day:'numeric', month:'numeric', hour:'2-digit', minute:'2-digit', second:'2-digit' });
  const km = m => ((m || 0) / 1000).toFixed(2).replace('.', ',') + ' km';
  const mins = s => Math.floor(s / 60) + ':' + String(Math.round(s % 60)).padStart(2, '0');
  const pace = (m, s) => m > 0 ? mins(s / (m / 1000)) + ' /km' : '–';
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const ls = { get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} } };
  const p2 = n => String(n).padStart(2, '0');
  const stamp = ms => { const d = new Date(ms); return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + '-' + p2(d.getHours()) + p2(d.getMinutes()); };
  const button = (text, color) => { const b = document.createElement('button'); b.textContent = text; b.style.cssText = 'font:inherit;padding:10px 14px;margin:8px 8px 0 0;border-radius:10px;border:1px solid ' + (color || '#0b6bcb') + ';background:' + (color || '#0b6bcb') + ';color:#fff'; body.appendChild(b); return b; };
  const stop = msg => { L('✗ ' + msg, BAD); L('Původní běh v Corosu zůstal nedotčený.', MUTED); };

  // ---------- pomocné: MD5, ZIP, base64, AWS podpis ----------
  function md5Hex(bytes) {
    const K = new Uint32Array(64), S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
    for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296);
    const n = bytes.length, total = ((n + 8) >>> 6) + 1, M = new Uint32Array(total * 16);
    for (let i = 0; i < n; i++) M[i >> 2] |= bytes[i] << ((i & 3) * 8);
    M[n >> 2] |= 0x80 << ((n & 3) * 8);
    M[total * 16 - 2] = (n * 8) >>> 0; M[total * 16 - 1] = Math.floor(n / 0x20000000);
    let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
    for (let o = 0; o < M.length; o += 16) {
      let A = a0, B = b0, C = c0, D = d0;
      for (let i = 0; i < 64; i++) {
        let F, g;
        if (i < 16) { F = (B & C) | (~B & D); g = i; }
        else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) & 15; }
        else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) & 15; }
        else { F = C ^ (B | ~D); g = (7 * i) & 15; }
        const s = S[(i >> 4) * 4 + (i & 3)];
        const t = (A + F + K[i] + M[o + g]) | 0;
        A = D; D = C; C = B; B = (B + ((t << s) | (t >>> (32 - s)))) | 0;
      }
      a0 = (a0 + A) | 0; b0 = (b0 + B) | 0; c0 = (c0 + C) | 0; d0 = (d0 + D) | 0;
    }
    return [a0, b0, c0, d0].map(v => { let h = ''; for (let i = 0; i < 4; i++) h += p2(((v >>> (i * 8)) & 255).toString(16)); return h; }).join('');
  }
  const CRC = (() => { const t = new Uint32Array(256); for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[i] = c >>> 0; } return t; })();
  const crc32 = d => { let c = 0xffffffff; for (let i = 0; i < d.length; i++) c = CRC[(c ^ d[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  function zipStored(entries) {   // entries: [{name, data|null(dir)}]
    const enc = new TextEncoder(), now = new Date();
    const dt = ((now.getUTCFullYear() - 1980) << 9) | ((now.getUTCMonth() + 1) << 5) | now.getUTCDate();
    const tm = (now.getUTCHours() << 11) | (now.getUTCMinutes() << 5) | (now.getUTCSeconds() >> 1);
    const parts = [], central = []; let off = 0;
    for (const e of entries) {
      const name = enc.encode(e.name), data = e.data || new Uint8Array(0), crc = e.data ? crc32(data) : 0;
      const h = new DataView(new ArrayBuffer(30));
      h.setUint32(0, 0x04034b50, true); h.setUint16(4, 10, true); h.setUint16(6, 0, true); h.setUint16(8, 0, true);
      h.setUint16(10, tm, true); h.setUint16(12, dt, true); h.setUint32(14, crc, true); h.setUint32(18, data.length, true); h.setUint32(22, data.length, true);
      h.setUint16(26, name.length, true); h.setUint16(28, 0, true);
      parts.push(new Uint8Array(h.buffer), name, data);
      const c = new DataView(new ArrayBuffer(46));
      c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 10, true); c.setUint16(8, 0, true); c.setUint16(10, 0, true);
      c.setUint16(12, tm, true); c.setUint16(14, dt, true); c.setUint32(16, crc, true); c.setUint32(20, data.length, true); c.setUint32(24, data.length, true);
      c.setUint16(28, name.length, true); c.setUint32(38, e.data ? 0 : 0x10, true); c.setUint32(42, off, true);
      central.push(new Uint8Array(c.buffer), name);
      off += 30 + name.length + data.length;
    }
    const cdSize = central.reduce((a, x) => a + x.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, entries.length, true); end.setUint16(10, entries.length, true);
    end.setUint32(12, cdSize, true); end.setUint32(16, off, true);
    const all = [...parts, ...central, new Uint8Array(end.buffer)];
    const out = new Uint8Array(all.reduce((a, x) => a + x.length, 0)); let p = 0; for (const x of all) { out.set(x, p); p += x.length; }
    return out;
  }
  const b64 = bytes => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(s); };
  const b64text = str => b64(new TextEncoder().encode(str));
  const hex = buf => Array.from(new Uint8Array(buf)).map(b => p2(b.toString(16))).join('');
  const sha256 = async d => hex(await crypto.subtle.digest('SHA-256', d));
  async function hmac(key, data) {
    const k = await crypto.subtle.importKey('raw', typeof key === 'string' ? new TextEncoder().encode(key) : key, { name:'HMAC', hash:'SHA-256' }, false, ['sign']);
    return crypto.subtle.sign('HMAC', k, new TextEncoder().encode(data));
  }
  async function s3Put(cr, key, data) {
    const host = cr.Bucket + '.s3.' + cr.Region + '.amazonaws.com', path = '/' + key.split('/').map(encodeURIComponent).join('/');
    const amz = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '').slice(0, 15) + 'Z', day = amz.slice(0, 8);
    const ph = await sha256(data), ct = 'application/zip';
    const sh = 'content-type;host;x-amz-content-sha256;x-amz-date' + (cr.SessionToken ? ';x-amz-security-token' : '');
    const ch = 'content-type:' + ct + '\nhost:' + host + '\nx-amz-content-sha256:' + ph + '\nx-amz-date:' + amz + '\n' + (cr.SessionToken ? 'x-amz-security-token:' + cr.SessionToken + '\n' : '');
    const creq = ['PUT', path, '', ch, sh, ph].join('\n');
    const scope = day + '/' + cr.Region + '/s3/aws4_request';
    const sts = ['AWS4-HMAC-SHA256', amz, scope, await sha256(new TextEncoder().encode(creq))].join('\n');
    let k = await hmac('AWS4' + cr.SecretAccessKey, day); k = await hmac(k, cr.Region); k = await hmac(k, 's3'); k = await hmac(k, 'aws4_request');
    const sig = hex(await hmac(k, sts));
    const headers = { 'Content-Type':ct, 'x-amz-content-sha256':ph, 'x-amz-date':amz, Authorization:'AWS4-HMAC-SHA256 Credential=' + cr.AccessKeyId + '/' + scope + ', SignedHeaders=' + sh + ', Signature=' + sig };
    if (cr.SessionToken) headers['x-amz-security-token'] = cr.SessionToken;
    const r = await fetch('https://' + host + path, { method:'PUT', headers, body:data });
    if (!r.ok) throw new Error('S3 ' + r.status + ' ' + (await r.text()).slice(0, 200));
  }

  try {
    if (!FIT) throw new Error('chybí knihovna pro FIT');
    if (!/coros\.com$/.test(location.hostname)) { L('Spusťte mě na stránce Training Hubu (t.coros.com) po přihlášení.', BAD); return; }

    // ---------- 1) přihlášení stránky ----------
    const cands = [];
    document.cookie.split(';').forEach(c => {
      const i = c.indexOf('='); if (i < 0) return;
      const k = c.slice(0, i).trim(); let v = c.slice(i + 1).trim(); try { v = decodeURIComponent(v); } catch (e) {}
      if (/coros-token/i.test(k) && v) cands.unshift(v); else if (/token/i.test(k) && !/csrf/i.test(k) && v) cands.push(v);
    });
    const bases = ['https://teameuapi.coros.com', 'https://teamapi.coros.com'];
    let api = null, tok = null, user = null;
    search: for (const v of cands) for (const b of bases) {
      try { const j = await (await fetch(b + '/account/query', { headers:{ accessToken:v } })).json(); if (j.result === '0000' && j.data) { api = b; tok = v; user = j.data; break search; } } catch (e) {}
    }
    if (!api) { L('✗ Nenašel jsem platné přihlášení. Přihlaste se na stránce Corosu a spusťte záložku znovu.', BAD); return; }
    const H = { accessToken:tok }; if (user.userId) H.yfheader = JSON.stringify({ userId:user.userId });
    const eu = /teameu/.test(api);
    const coros = async (path, opt = {}) => {
      const r = await fetch(api + '/' + path, { ...opt, headers:{ ...H, ...(opt.headers || {}) } });
      const j = await r.json(); if (j.result !== '0000') throw new Error('Coros ' + path + ': ' + j.message + ' (' + j.result + ')'); return j.data;
    };
    L('✓ Přihlášení do Corosu (' + (eu ? 'Evropa' : 'Amerika') + ')', OK);

    // ---------- 2) poslední běh na pásu ----------
    const listActs = async () => ((await coros('activity/query?size=20&pageNumber=1')) || {}).dataList || [];
    const acts = await listActs();
    const act = acts.find(a => a.sportType === 101 && (a.name || '') !== NAME_FIXED);
    if (!act) { L('✗ Mezi posledními 20 aktivitami není neopravený běh na pásu.', BAD); return; }
    const as = act.startTime * 1000, ae = act.endTime ? act.endTime * 1000 : as + (act.totalTime || 0) * 1000;
    L('✓ Běh z hodinek: ' + fmt(as) + ' · ' + (act.name || '') + ' · ' + km(act.distance) + ' · ' + mins(act.totalTime || 0), OK);
    L('   hodinky: ' + fmtS(as) + ' – ' + fmtS(ae), MUTED);

    // ---------- 3) GitHub a záznam z pásu ----------
    let ghTok = ls.get('pasGhToken'), ghRepo = ls.get('pasGhRepo') || 'pas-data';
    if (!ghTok) {
      const f = document.createElement('div');
      f.innerHTML = '<p style="margin:10px 0 4px">Vložte jednou klíč ke GitHubu (stejný jako v aplikaci). Uloží se jen v tomto prohlížeči.</p><input id="pcRepo" style="font:inherit;width:100%;padding:6px;margin:4px 0"><input id="pcTok" type="password" placeholder="github_pat_…" style="font:inherit;width:100%;padding:6px;margin:4px 0"><button id="pcSave" style="font:inherit;padding:8px 12px">Uložit a pokračovat</button>';
      body.appendChild(f); f.querySelector('#pcRepo').value = ghRepo;
      await new Promise(res => { f.querySelector('#pcSave').onclick = res; });
      ghTok = f.querySelector('#pcTok').value.trim(); ghRepo = f.querySelector('#pcRepo').value.trim().replace(/^.*\//, '') || 'pas-data';
      if (!ghTok) { L('✗ Klíč nebyl zadán.', BAD); return; }
      ls.set('pasGhToken', ghTok); ls.set('pasGhRepo', ghRepo); f.remove();
    }
    const gh = async (path, opt = {}, raw) => {
      const r = await fetch('https://api.github.com' + path, { cache:'no-store', ...opt, headers:{ Authorization:'Bearer ' + ghTok, Accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json', ...(opt.headers || {}) } });
      if (r.status === 404 && (!opt.method || opt.method === 'GET')) return null;
      if (r.status === 401) { try { localStorage.removeItem('pasGhToken'); } catch (e) {} throw new Error('klíč ke GitHubu je neplatný (při dalším spuštění zadejte nový)'); }
      if (!r.ok) throw new Error('GitHub ' + r.status + ' ' + (await r.text()).slice(0, 150));
      return raw ? r.text() : r.json();
    };
    const me = await gh('/user');
    const repo = '/repos/' + me.login + '/' + ghRepo + '/contents/';
    const ghPut = async (path, contentB64, message) => {
      const cur = await gh(repo + path.split('/').map(encodeURIComponent).join('/'));
      const bodyJ = { message, content:contentB64 }; if (cur && cur.sha) bodyJ.sha = cur.sha;
      return gh(repo + path.split('/').map(encodeURIComponent).join('/'), { method:'PUT', body:JSON.stringify(bodyJ) });
    };
    const list = await gh(repo + 'zaznamy');
    if (!Array.isArray(list)) { L('✗ Na GitHubu (' + me.login + '/' + ghRepo + ') není složka se záznamy.', BAD); return; }
    const near = list.map(f => { const m = f.name.match(/^(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})-(.+)\.json$/); return m ? { name:f.name, t:new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5]).getTime() } : null; })
      .filter(f => f && Math.abs(f.t - as) < 3 * 3600 * 1000);
    let rec = null;
    for (const f of near) {
      const d = JSON.parse(await gh(repo + 'zaznamy/' + encodeURIComponent(f.name), {}, true));
      const s = d.samples || []; if (!s.length) continue;
      if (d.opraveno) { L('   (záznam ' + f.name + ' už byl použitý ' + fmt(d.opraveno.cas) + ', přeskakuji)', MUTED); continue; }
      const ov = Math.min(s[s.length - 1][0], ae) - Math.max(s[0][0], as);
      L('   pás: ' + fmtS(s[0][0]) + ' – ' + fmtS(s[s.length - 1][0]) + ' · překryv ' + Math.max(0, Math.round(ov / 1000)) + ' s · ' + f.name, MUTED);
      if (ov > 60000 && (!rec || ov > rec.ov)) rec = { name:f.name, ov, d };
    }
    if (!rec) { L('✗ K tomuto běhu jsem na GitHubu nenašel nepoužitý záznam z pásu (hledal jsem ±3 h).', BAD); return; }
    L('✓ Záznam z pásu: ' + fmt(rec.d.meta.startedAt) + ' · ' + (rec.d.meta.workout || '') + ' (překryv ' + Math.round(rec.ov / 1000) + ' s)', OK);

    // ---------- 4) stažení originálu a záloha na GitHub ----------
    const dl = await coros('activity/detail/download?labelId=' + encodeURIComponent(act.labelId) + '&sportType=' + act.sportType + '&fileType=4', { method:'POST' });
    if (!dl || !dl.fileUrl) throw new Error('Coros nevrátil odkaz ke stažení');
    let origBytes;
    try { const r = await fetch(dl.fileUrl); if (!r.ok) throw new Error('HTTP ' + r.status); origBytes = new Uint8Array(await r.arrayBuffer()); }
    catch (e) { throw new Error('stažení FIT se nepovedlo (' + e.message + ')'); }
    const info = FIT.summary(origBytes);
    L('✓ Stažen původní FIT (' + Math.round(origBytes.length / 1024) + ' kB, začátek ' + fmt(info.start.getTime()) + ')', OK);
    const origPath = 'coros-original/' + stamp(as) + '-original.fit';
    await ghPut(origPath, b64(origBytes), 'Původní FIT z Corosu ' + fmt(as));
    L('✓ Originál uložen na GitHub: ' + origPath, OK);

    // ---------- 5) oprava ----------
    const al = FIT.align(origBytes, rec.d.samples);
    let chosen = al.offset;
    if (al.ambiguous) {
      const sg = v => (v > 0 ? '+' : '') + v + ' s';
      L('? Sladění času hodinek a pásu podle tepu není jednoznačné: stejně dobře sedí posuny od ' + sg(al.from) + ' do ' + sg(al.to) + ' (nejlepší ' + sg(al.offset) + '). Jak pokračovat?', BAD);
      chosen = await new Promise(res => {
        const bs = [];
        const add = (t, v, c) => { const b = button(t, c); bs.push(b); b.onclick = () => { bs.forEach(x => x.remove()); res(v); }; };
        add('Použít ' + sg(al.offset), al.offset);
        if (al.offset !== 0) add('Bez posunu (0 s)', 0, '#667085');
        add('Zrušit', null, '#667085');
      });
      if (chosen === null) { stop('Oprava zrušena (originál je zálohovaný na GitHubu).'); return; }
      L('   zvolený posun: ' + chosen + ' s', MUTED);
    }
    const errC = al.matched ? al.errorAt(chosen) : null;
    if (errC != null && errC > FIT.HR_WARN) {
      L('? Tep v záznamu z hodinek a z pásu se při posunu ' + chosen + ' s liší v průměru o ' + errC.toFixed(1).replace('.', ',') + ' tepu. Obvykle to znamená, že záznamy nepatří ke stejnému běhu, nebo že hodinky vysílaly tep přerušovaně. Pokračovat?', BAD);
      const go = await new Promise(res => {
        const bs = []; const add = (t, v, c) => { const b = button(t, c); bs.push(b); b.onclick = () => { bs.forEach(x => x.remove()); res(v); }; };
        add('Pokračovat', true); add('Zrušit', false, '#667085');
      });
      if (!go) { stop('Oprava zrušena (originál je zálohovaný na GitHubu).'); return; }
      L('   pokračuji i přes vyšší odchylku tepu', MUTED);
    }
    const res = FIT.merge(origBytes, rec.d.samples, { preserve:true, offset:chosen });
    L('✓ Opraveno: ' + km(res.stats.distance) + ' (hodinky ' + km(act.distance) + '), převýšení ' + Math.round(res.stats.ascent) + ' m, posun hodin ' + res.offset + ' s' + (res.hrMatch ? '' : ' – časy nesladěny podle tepu'), OK);

    // ---------- 6) nahrání do Corosu (po krocích s výpisem) ----------
    const step = async (label, fn) => {
      const line = L('… ' + label, MUTED);
      try { const v = await fn(); line.textContent = '✓ ' + label; line.style.color = OK; return v; }
      catch (e) {
        const blocked = e instanceof TypeError || /Failed to fetch|NetworkError|Load failed/i.test(e.message);
        line.textContent = '✗ ' + label + ': ' + e.message + (blocked ? ' (prohlížeč požadavek zablokoval nebo server neodpověděl)' : ''); line.style.color = BAD;
        throw new Error('nahrání se zastavilo v kroku „' + label + '“');
      }
    };
    const stsUrl = 'https://faq.coros.com/openapi/oss/sts?bucket=' + (eu ? 'eu-coros' : 'coros-s3') + '&service=aws&v=2&app_id=1660188068672619112&sign=' + (eu ? '877571111A1EE5316E4B590103D4B5B3' : 'E34EF0E34A498A54A9C3EAEFC12B7CAF');
    const cr = await step('1/3 oprávnění k nahrání (faq.coros.com)', async () => {
      const r = await fetch(stsUrl); const t = await r.text();
      let sts; try { sts = JSON.parse(t); } catch (e) { throw new Error('HTTP ' + r.status + ', odpověď není JSON: ' + t.slice(0, 120)); }
      if (sts.code !== 200 || !sts.data || !sts.data.credentials) throw new Error('HTTP ' + r.status + ', ' + (sts.msg || sts.code));
      const c = JSON.parse(atob(sts.data.credentials.replace('9y78gpoERW4lBNYL', '')));
      if (!c.Bucket || !c.Region) throw new Error('neúplná oprávnění');
      return c;
    });
    const fileName = 'pas-' + stamp(as) + '.fit', md5 = md5Hex(res.bytes);
    const zip = zipStored([{ name:md5 + '/', data:null }, { name:md5 + '/' + fileName, data:res.bytes }]);
    const object = 'fit_zip/' + user.userId + '/' + md5 + '.zip';
    await step('2/3 nahrání souboru (' + cr.Bucket + '.s3.' + cr.Region + '.amazonaws.com)', () => s3Put(cr, object, zip));
    const fd = new FormData();
    fd.append('jsonParameter', JSON.stringify({ source:1, timezone:(-new Date().getTimezoneOffset() / 60) * 4, bucket:cr.Bucket, md5, size:zip.length, object, serviceName:'aws', oriFileName:fileName }));
    const ih = { AccessToken:tok }; if (H.yfheader) ih.yfheader = H.yfheader;   // import chce token v hlavičce AccessToken
    await step('3/3 registrace importu (' + api.replace('https://', '') + ')', async () => {
      const r = await fetch(api + '/activity/fit/import', { method:'POST', body:fd, headers:ih }); const t = await r.text();
      let ir; try { ir = JSON.parse(t); } catch (e) { throw new Error('HTTP ' + r.status + ', odpověď není JSON: ' + t.slice(0, 120)); }
      if (ir.result !== '0000') throw new Error(ir.message + ' (' + ir.result + ')');
    });
    const wait = L('… Soubor nahrán, čekám, až ho Coros zpracuje', MUTED);
    let fixed = null;
    for (let i = 0; i < 36 && !fixed; i++) {
      await sleep(5000);
      wait.textContent = '… Čekám na zpracování v Corosu (' + (i + 1) * 5 + ' s)';
      fixed = (await listActs()).find(a => a.labelId !== act.labelId && Math.abs(a.startTime - act.startTime) <= 60);
    }
    if (!fixed) { stop('Coros nový běh do 3 minut nevytvořil. Zkontrolujte na webu import (Activity List → Import Data). Originál je zálohovaný na GitHubu.'); return; }
    L('✓ Nový běh v Corosu: ' + fmt(fixed.startTime * 1000) + ' · ' + km(fixed.distance), OK);

    // ---------- 7) přejmenování a značka na GitHubu ----------
    try { await coros('activity/update', { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ labelId:fixed.labelId, name:NAME_FIXED, type:1 }) }); L('✓ Přejmenováno na „' + NAME_FIXED + '“', OK); }
    catch (e) { L('! Přejmenování se nepovedlo: ' + e.message, BAD); }
    try {
      const d = { ...rec.d, opraveno:{ cas:Date.now(), noveId:fixed.labelId, puvodniId:act.labelId, original:origPath } };
      await ghPut('zaznamy/' + rec.name, b64text(JSON.stringify(d)), 'Záznam použit pro opravu ' + fmt(as));
      L('✓ Záznam z pásu na GitHubu označen jako použitý', OK);
    } catch (e) { L('! Označení na GitHubu se nepovedlo: ' + e.message, BAD); }

    // ---------- 8) potvrzené smazání originálu ----------
    const t = document.createElement('div');
    t.style.cssText = 'margin-top:12px;border:2px solid ' + BAD + ';border-radius:10px;padding:10px';
    const row = (label, a, b) => '<tr><td style="padding:3px 8px 3px 0;color:' + MUTED + '">' + label + '</td><td style="padding:3px 8px"><b>' + a + '</b></td><td style="padding:3px 0">' + b + '</td></tr>';
    t.innerHTML = '<b style="color:' + BAD + '">Smazat tento původní běh?</b><table style="margin-top:6px;border-collapse:collapse">' +
      '<tr><td></td><td style="padding:3px 8px;color:' + BAD + '">SMAZAT</td><td style="color:' + OK + '">ZŮSTANE</td></tr>' +
      row('Název', act.name || '–', NAME_FIXED) +
      row('Začátek', fmt(as), fmt(fixed.startTime * 1000)) +
      row('Délka', mins(act.totalTime || 0), mins(fixed.totalTime || 0)) +
      row('Vzdálenost', km(act.distance), km(fixed.distance)) +
      row('Tempo', pace(act.distance, act.totalTime || 0), pace(fixed.distance, fixed.totalTime || 0)) +
      row('Typ', act.sportType === 101 ? 'běh na pásu' : act.sportType, fixed.sportType === 101 ? 'běh na pásu' : fixed.sportType) +
      row('ID v Corosu', act.labelId, fixed.labelId) + '</table>';
    body.appendChild(t);
    const del = button('Smazat tento běh', BAD), keep = button('Nemazat', '#667085');
    keep.onclick = () => { del.remove(); keep.remove(); L('Původní běh ponechán. Můžete ho smazat ručně.', MUTED); };
    del.onclick = async () => {
      del.disabled = keep.disabled = true; del.textContent = 'Mažu…';
      try {
        await coros('activity/delete?labelId=' + encodeURIComponent(act.labelId));
        await sleep(2000);
        const after = await listActs();
        const gone = !after.some(a => a.labelId === act.labelId), stays = after.some(a => a.labelId === fixed.labelId);
        del.remove(); keep.remove();
        if (gone && stays) L('✓ Původní běh smazán, opravený zůstal. Hotovo – stránku obnovte, ať se seznam aktualizuje.', OK);
        else L('! Kontrola po smazání: původní ' + (gone ? 'zmizel' : 'STÁLE JE v seznamu') + ', opravený ' + (stays ? 'je v seznamu' : 'v seznamu NENÍ') + '.', BAD);
      } catch (e) { del.disabled = keep.disabled = false; del.textContent = 'Smazat tento běh'; L('✗ Smazání selhalo: ' + e.message, BAD); }
    };
  } catch (e) {
    stop('Chyba: ' + e.message);
    L('Pošlete mi prosím tento výpis.', MUTED);
  }
})();
