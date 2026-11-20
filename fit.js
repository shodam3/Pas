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
  const locals = {};
  let p = hsize, end = hsize + dataSize, lastTs = 0;
  while (p < end) {
    const h = b[p++];
    if (h & 0x80) { // komprimovaná časová značka
      const local = (h >> 5) & 0x3, off = h & 0x1F;
      const def = locals[local]; if (!def) throw new Error('Chybí definice');
      let ts = (lastTs & ~0x1F) + off; if (off < (lastTs & 0x1F)) ts += 0x20; lastTs = ts;
      const raw = b.slice(p, p + def.len); p += def.len;
      out.messages.push({ def, raw, cts:ts });
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
      locals[local] = { global, arch, fields, devFields, len:off };
    } else {
      const def = locals[local]; if (!def) throw new Error('Chybí definice');
      const raw = b.slice(p, p + def.len); p += def.len;
      const m = { def, raw };
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
function encode(fit) {
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

// ---------- sloučení ----------
// samples: [[ms, rychlost km/h, vzdálenost m, sklon %, tep, pauza 0/1, index úseku], ...]
function merge(watchBytes, samples, opts = {}) {
  const fit = decode(watchBytes);
  const msgs = fit.messages;
  const recs = msgs.filter(m => m.def.global === MSG.record);
  if (recs.length < 10) throw new Error('Soubor z hodinek neobsahuje záznam běhu');
  if (!samples || samples.length < 10) throw new Error('Záznam z pásu je prázdný');
  const unix = m => getField(m, 253) + FIT_EPOCH;

  // 1) časový posun hodin – podle průběhu tepu (obě řady jsou z hodinek)
  const wHr = new Map(); recs.forEach(m => { const h = getField(m, 3); if (h) wHr.set(unix(m), h); });
  const tHr = new Map(); samples.forEach(s => { if (s[4]) tHr.set(Math.round(s[0] / 1000), s[4]); });
  let offset = 0, bestErr = Infinity, bestN = 0;
  for (let off = -180; off <= 180; off++) {
    let sum = 0, n = 0;
    for (const [t, h] of wHr) { const x = tHr.get(t + off); if (x) { sum += Math.abs(x - h); n++; } }
    if (n >= 60 && sum / n < bestErr) { bestErr = sum / n; offset = off; bestN = n; }
  }
  if (!bestN) offset = 0;

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
    ensureField(m, 6, 2, 0x84); ensureField(m, 2, 2, 0x84); ensureField(m, 9, 2, 0x83);
    setField(m, 5, d * 100);
    setField(m, 9, x.inc * 100);   // sklon v % × 100
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
  const useSteps = opts.laps !== 'km' && samples.some(s => s[6] > 0);
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
      const L = cloneMsg(oldLaps[Math.min(i, oldLaps.length - 1)]);
      const inner0 = pts.filter(p => p.t >= a && p.t < b);
      ensureField(L, 45, 2, 0x83); ensureField(L, 48, 2, 0x83);
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

  // 5) souhrn běhu
  const totalD = pts[pts.length - 1].d;
  msgs.filter(m => m.def.global === MSG.session).forEach(S => {
    const timer = (getField(S, 8) || 0) / 1000;
    setField(S, 9, totalD * 100);
    setField(S, 14, timer ? totalD / timer * 1000 : 0);
    setField(S, 15, Math.max(...pts.map(p => p.v)) * 1000);
    setField(S, 22, ascent); setField(S, 23, 0);
    ensureField(S, 52, 2, 0x83); ensureField(S, 55, 2, 0x83);
    setField(S, 52, avgGrade(pts) * 100); setField(S, 55, Math.max(0, ...pts.map(p => p.inc)) * 100);
    const cyc = getField(S, 10); if (cyc) setField(S, 134, totalD / cyc / 2 * 10000);   // mm × 10
  });

  // nahradit staré okruhy novými na stejném místě
  if (oldLaps.length) {
    const first = msgs.indexOf(oldLaps[0]);
    const rest = msgs.filter(m => m.def.global !== MSG.lap);
    const before = msgs.slice(0, first).filter(m => m.def.global !== MSG.lap).length;
    rest.splice(before, 0, ...newLaps);
    fit.messages = rest;
  }
  const bytes = encode(fit);
  return {
    bytes, offset, hrMatch:bestN ? { error:bestErr, points:bestN } : null,
    stats:{ distance:totalD, ascent, laps:newLaps.length, start:new Date(t0 * 1000), end:new Date(tEnd * 1000),
            covered:samples[0][0] / 1000 - offset <= t0 + 120 && samples[samples.length - 1][0] / 1000 - offset >= tEnd - 120 }
  };
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

const api = { decode, encode, merge, summary, getField, setField, crc16, FIT_EPOCH };
if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.FIT = api;
})(typeof window !== 'undefined' ? window : globalThis);
