// Pás – oprava, krok 1: pouze kontrola (nic nestahuje, nenahrává ani nemaže).
// Spouští se jako záložka (bookmarklet) na stránce t.coros.com.
(async () => {
  const ID = 'pas-coros-panel';
  const old = document.getElementById(ID); if (old) old.remove();
  const box = document.createElement('div'); box.id = ID;
  box.style.cssText = 'position:fixed;left:8px;right:8px;top:8px;bottom:8px;z-index:2147483647;background:#fff;color:#111;font:14px/1.45 system-ui,sans-serif;border:2px solid #0b6bcb;border-radius:12px;padding:12px;overflow:auto;box-shadow:0 4px 24px rgba(0,0,0,.35)';
  box.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px"><b>Pás – oprava (krok 1: jen kontrola)</b><button id="pcX" style="font:inherit;padding:6px 12px">Zavřít</button></div><div id="pcBody" style="margin-top:8px"></div>';
  document.body.appendChild(box);
  box.querySelector('#pcX').onclick = () => box.remove();
  const body = box.querySelector('#pcBody');
  const L = (t, c) => { const d = document.createElement('div'); d.textContent = t; if (c) d.style.color = c; d.style.whiteSpace = 'pre-wrap'; body.appendChild(d); return d; };
  const OK = '#127a3e', BAD = '#b42318', MUTED = '#667085';
  const fmt = ms => new Date(ms).toLocaleString('cs-CZ', { day:'numeric', month:'numeric', year:'numeric', hour:'2-digit', minute:'2-digit' });
  const ls = { get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} } };

  try {
    if (!/coros\.com$/.test(location.hostname)) { L('Spusťte mě na stránce t.coros.com (po přihlášení).', BAD); return; }

    // ---------- 1) přihlášení Corosu, které už stránka má ----------
    const cands = [];
    document.cookie.split(';').forEach(c => {
      const i = c.indexOf('='); if (i < 0) return;
      const k = c.slice(0, i).trim(); let v = c.slice(i + 1).trim();
      try { v = decodeURIComponent(v); } catch (e) {}
      if (/token/i.test(k) && v) cands.push(['cookie ' + k, v]);
    });
    [['localStorage', localStorage], ['sessionStorage', sessionStorage]].forEach(([n, st]) => {
      try {
        for (let i = 0; i < st.length; i++) {
          const k = st.key(i); if (!/token/i.test(k) || /^pas/i.test(k)) continue;   // vlastní klíč ke GitHubu Corosu neposílat
          let v = st.getItem(k);
          try { const j = JSON.parse(v); if (typeof j === 'string') v = j; else if (j && (j.accessToken || j.token)) v = j.accessToken || j.token; } catch (e) {}
          if (v) cands.push([n + ' ' + k, v]);
        }
      } catch (e) {}
    });
    L('Místa s přihlášením: ' + (cands.map(c => c[0]).join(', ') || 'nenalezena'), MUTED);
    const bases = ['https://teameuapi.coros.com', 'https://teamapi.coros.com'];
    let api = null, tok = null, user = null;
    search: for (const [src, v] of cands) for (const b of bases) {
      try {
        const j = await (await fetch(b + '/account/query', { headers:{ accessToken:v } })).json();
        if (j.result === '0000' && j.data) { api = b; tok = v; user = j.data; L('✓ Přihlášení do Corosu: ' + src + ' → ' + b.replace('https://', ''), OK); break search; }
      } catch (e) { L('  ' + src + ' / ' + b.replace('https://', '') + ': ' + e.message, MUTED); }
    }
    if (!api) { L('✗ Nenašel jsem platné přihlášení. Jste na t.coros.com přihlášený? Pošlete mi prosím tento výpis.', BAD); return; }
    const H = { accessToken:tok }; if (user.userId) H.yfheader = JSON.stringify({ userId:user.userId });

    // ---------- 2) poslední aktivity ----------
    const aj = await (await fetch(api + '/activity/query?size=20&pageNumber=1', { headers:H })).json();
    if (aj.result !== '0000') { L('✗ Seznam aktivit: ' + aj.message + ' (' + aj.result + ')', BAD); return; }
    const acts = (aj.data && aj.data.dataList) || [];
    L('✓ Načteno aktivit: ' + acts.length, OK);
    acts.slice(0, 5).forEach(a => L('   • ' + fmt(a.startTime * 1000) + ' · typ ' + a.sportType + ' · ' + ((a.distance || 0) / 1000).toFixed(2) + ' km · ' + Math.round((a.totalTime || 0) / 60) + ' min' + (a.name ? ' · ' + a.name : ''), MUTED));
    const runs = acts.filter(a => a.sportType === 101 || a.sportType === 100);
    const act = runs.find(a => a.sportType === 101) || runs[0];
    if (!act) { L('✗ Mezi posledními aktivitami není běh.', BAD); return; }
    const as = act.startTime * 1000, ae = (act.endTime ? act.endTime * 1000 : as + (act.totalTime || 0) * 1000);
    L('→ Vybraný běh z hodinek: ' + fmt(as) + ', ' + Math.round((ae - as) / 60000) + ' min, ' + ((act.distance || 0) / 1000).toFixed(2) + ' km (typ ' + act.sportType + (act.sportType === 101 ? ' = běh na pásu' : ' = běh venku') + ')');

    // ---------- 3) GitHub ----------
    let ghTok = ls.get('pasGhToken'), ghRepo = ls.get('pasGhRepo') || 'pas-data';
    if (!ghTok) {
      const f = document.createElement('div');
      f.innerHTML = '<p style="margin:10px 0 4px">Pro hledání záznamu z pásu vložte jednou klíč ke GitHubu (stejný jako v aplikaci). Uloží se jen v tomto prohlížeči.</p>' +
        '<input id="pcRepo" value="' + ghRepo + '" style="font:inherit;width:100%;padding:6px;margin:4px 0">' +
        '<input id="pcTok" type="password" placeholder="github_pat_…" style="font:inherit;width:100%;padding:6px;margin:4px 0">' +
        '<button id="pcSave" style="font:inherit;padding:8px 12px">Uložit a pokračovat</button>';
      body.appendChild(f);
      await new Promise(res => { f.querySelector('#pcSave').onclick = res; });
      ghTok = f.querySelector('#pcTok').value.trim(); ghRepo = f.querySelector('#pcRepo').value.trim().replace(/^.*\//, '') || 'pas-data';
      if (!ghTok) { L('✗ Klíč nebyl zadán.', BAD); return; }
      ls.set('pasGhToken', ghTok); ls.set('pasGhRepo', ghRepo); f.remove();
    }
    const gh = async (path, raw) => {
      const r = await fetch('https://api.github.com' + path, { cache:'no-store', headers:{ Authorization:'Bearer ' + ghTok, Accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json' } });
      if (r.status === 404) return null;
      if (r.status === 401) { try { localStorage.removeItem('pasGhToken'); } catch (e) {} throw new Error('klíč ke GitHubu je neplatný (smazal jsem ho, při dalším spuštění zadejte nový)'); }
      if (!r.ok) throw new Error('GitHub ' + r.status);
      return raw ? r.text() : r.json();
    };
    const me = await gh('/user'); if (!me) throw new Error('GitHub: uživatel nenalezen');
    const list = await gh('/repos/' + me.login + '/' + ghRepo + '/contents/zaznamy');
    if (!Array.isArray(list)) { L('✗ Na GitHubu (' + me.login + '/' + ghRepo + ') jsem nenašel složku se záznamy.', BAD); return; }
    L('✓ GitHub: ' + me.login + '/' + ghRepo + ', záznamů celkem ' + list.length, OK);
    const near = list.map(f => {
      const m = f.name.match(/^(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})-(.+)\.json$/);
      return m ? { name:f.name, t:new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5]).getTime() } : null;
    }).filter(f => f && Math.abs(f.t - as) < 3 * 3600 * 1000);
    L('Záznamů z pásu v rozmezí ±3 h: ' + near.length, MUTED);
    let best = null;
    for (const f of near) {
      const d = JSON.parse(await gh('/repos/' + me.login + '/' + ghRepo + '/contents/zaznamy/' + encodeURIComponent(f.name), true));
      const s = d.samples || []; if (!s.length) continue;
      const ov = Math.min(s[s.length - 1][0], ae) - Math.max(s[0][0], as);
      L('   • ' + f.name + ' · ' + (d.meta && d.meta.workout || '') + ' · překryv ' + Math.max(0, Math.round(ov / 1000)) + ' s', MUTED);
      if (ov > 60000 && (!best || ov > best.ov)) best = { f, ov, d };
    }
    if (!best) { L('✗ K běhu z hodinek jsem na GitHubu nenašel odpovídající záznam z pásu.', BAD); return; }
    L('✓ Odpovídající záznam z pásu: ' + fmt(best.d.meta.startedAt) + ' · ' + (best.d.meta.workout || '') + ' (překryv ' + Math.round(best.ov / 1000) + ' s)', OK);
    L('\nKrok 1 je v pořádku: v kroku 2 by se tento běh opravil, nahrál a původní smazal. Nic jsem nezměnil.', OK);
  } catch (e) {
    L('✗ Chyba: ' + e.message, BAD);
    L('Pošlete mi prosím tento výpis.', MUTED);
  }
})();
