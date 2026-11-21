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
    const res = FIT.merge(origBytes, rec.d.samples, { preserve:true });
    L('✓ Opraveno: ' + km(res.stats.distance) + ' (hodinky ' + km(act.distance) + '), převýšení ' + Math.round(res.stats.ascent) + ' m, posun hodin ' + res.offset + ' s' + (res.hrMatch ? '' : ' – časy nesladěny podle tepu'), OK);
    if (res.hrMatch && res.hrMatch.error > 5) L('   Pozor: tep v obou záznamech se dost liší.', BAD);

    // ---------- 6) nahrání do Corosu ----------
    const sts = await (await fetch('https://faq.coros.com/openapi/oss/sts?bucket=' + (eu ? 'eu-coros' : 'coros-s3') + '&service=aws&v=2&app_id=1660188068672619112&sign=' + (eu ? '877571111A1EE5316E4B590103D4B5B3' : 'E34EF0E34A498A54A9C3EAEFC12B7CAF'))).json();
    if (sts.code !== 200 || !sts.data || !sts.data.credentials) throw new Error('Coros nevydal oprávnění k nahrání (' + (sts.msg || sts.code) + ')');
    const cr = JSON.parse(atob(sts.data.credentials.replace('9y78gpoERW4lBNYL', '')));
    const fileName = 'pas-' + stamp(as) + '.fit', md5 = md5Hex(res.bytes);
    const zip = zipStored([{ name:md5 + '/', data:null }, { name:md5 + '/' + fileName, data:res.bytes }]);
    const object = 'fit_zip/' + user.userId + '/' + md5 + '.zip';
    await s3Put(cr, object, zip);
    const fd = new FormData();
    fd.append('jsonParameter', JSON.stringify({ source:1, timezone:(-new Date().getTimezoneOffset() / 60) * 4, bucket:cr.Bucket, md5, size:zip.length, object, serviceName:'aws', oriFileName:fileName }));
    const ih = { AccessToken:tok }; if (H.yfheader) ih.yfheader = H.yfheader;   // import chce token v hlavičce AccessToken
    const ir = await (await fetch(api + '/activity/fit/import', { method:'POST', body:fd, headers:ih })).json();
    if (ir.result !== '0000') throw new Error('Coros import: ' + ir.message + ' (' + ir.result + ')');
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
