'use strict';
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const HIST = 60;

const S = {
  tunnels: [], settings: {}, wgInstalled: true, isAdmin: true, version: '', busy: null, packaged: false,
  active: null, selected: null, view: 'dash', stats: null,
  hist: { rx: [], tx: [], lat: [] }, update: { state: 'idle' }, wgInstalling: false,
};

/* ---------------------------------------------------------------- format */
function fmtRate(bps) {
  const bits = S.settings.units !== 'bytes';
  let v = bits ? bps * 8 : bps; const base = bits ? 1000 : 1024;
  const units = bits ? ['bit/s', 'kbit/s', 'Mbit/s', 'Gbit/s'] : ['B/s', 'KB/s', 'MB/s', 'GB/s'];
  let i = 0; while (v >= base && i < units.length - 1) { v /= base; i++; }
  return { v: v >= 100 || i === 0 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2), u: units[i] };
}
function fmtBytes(n) {
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; let v = n || 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v >= 100 || i === 0 ? v.toFixed(0) : v.toFixed(1)} ${u[i]}`;
}
function fmtDur(s) {
  s = Math.max(0, s | 0); const h = String((s / 3600) | 0).padStart(2, '0');
  return `${h}:${String(((s % 3600) / 60) | 0).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
function fmtAgo(s) {
  if (s == null) return 'Ingen endnu';
  if (s < 60) return `${s} sek. siden`;
  if (s < 3600) return `${Math.floor(s / 60)} min. siden`;
  return `${Math.floor(s / 3600)} t. siden`;
}
const latClass = (ms) => (ms == null ? '' : ms < 60 ? 'good' : ms < 150 ? 'ok' : 'bad');
const latColor = (ms) => ({ good: '#34d399', ok: '#fbbf24', bad: '#f87171' }[latClass(ms)] || '#8b90a8');

/* ----------------------------------------------------------------- charts */
function drawChart(canvas, data, color, opts = {}) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth; const h = canvas.clientHeight;
  if (!w || !h) return;
  if (canvas.width !== Math.round(w * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
  const c = canvas.getContext('2d');
  c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, w, h);

  // grid
  c.strokeStyle = 'rgba(255,255,255,.05)'; c.lineWidth = 1;
  for (let i = 1; i < 4; i++) { const y = Math.round((h / 4) * i) + .5; c.beginPath(); c.moveTo(0, y); c.lineTo(w, y); c.stroke(); }

  const vals = data.filter((v) => v != null);
  if (!vals.length) return;
  const max = Math.max(opts.minMax || 1, ...vals) * 1.15;
  const padT = 10; const padB = 4;
  const X = (i) => (i / (HIST - 1)) * w;
  const Y = (v) => h - padB - (v / max) * (h - padT - padB);
  const off = HIST - data.length;
  const pts = data.map((v, i) => (v == null ? null : [X(i + off), Y(v)]));

  // del i sammenhængende segmenter (timeouts giver huller)
  const segs = []; let cur = [];
  for (const p of pts) { if (p) cur.push(p); else if (cur.length) { segs.push(cur); cur = []; } }
  if (cur.length) segs.push(cur);
  const trace = (seg) => {
    c.moveTo(seg[0][0], seg[0][1]);
    for (let i = 1; i < seg.length; i++) { const mx = (seg[i - 1][0] + seg[i][0]) / 2; c.bezierCurveTo(mx, seg[i - 1][1], mx, seg[i][1], seg[i][0], seg[i][1]); }
  };
  const g = c.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, color + '55'); g.addColorStop(1, color + '00');
  for (const seg of segs) {
    c.beginPath(); trace(seg); c.lineTo(seg[seg.length - 1][0], h); c.lineTo(seg[0][0], h); c.closePath(); c.fillStyle = g; c.fill();
  }
  c.strokeStyle = color; c.lineWidth = 2; c.lineJoin = 'round'; c.shadowColor = color; c.shadowBlur = 10;
  for (const seg of segs) { c.beginPath(); trace(seg); c.stroke(); }
  c.shadowBlur = 0;
  const lastSeg = segs[segs.length - 1]; const last = lastSeg[lastSeg.length - 1];
  c.beginPath(); c.arc(last[0], last[1], 3.5, 0, 7); c.fillStyle = '#fff'; c.fill();
}

/* -------------------------------------------------------------- utilities */
function toast(text, kind = 'info') {
  const t = document.createElement('div'); t.className = `toast ${kind}`;
  t.innerHTML = `<i></i><span>${esc(text)}</span>`;
  $('#toasts').appendChild(t);
  setTimeout(() => { t.style.transition = '.3s'; t.style.opacity = '0'; t.style.transform = 'translateX(20px)'; setTimeout(() => t.remove(), 300); }, kind === 'error' ? 6000 : 3500);
}

function modal({ title, subtitle, body, actions }) {
  const root = $('#modalRoot');
  const back = document.createElement('div'); back.className = 'modal-back';
  back.innerHTML = `<div class="modal" role="dialog"><div class="modal-head"><h3>${esc(title)}</h3>${subtitle ? `<p>${esc(subtitle)}</p>` : ''}</div><div class="modal-body"></div><div class="modal-foot"></div></div>`;
  const close = () => { back.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
  const bodyEl = $('.modal-body', back); const foot = $('.modal-foot', back);
  if (typeof body === 'string') bodyEl.innerHTML = body; else bodyEl.appendChild(body);
  for (const a of actions) {
    const b = document.createElement('button'); b.className = `btn ${a.cls || ''}`; b.textContent = a.label;
    b.addEventListener('click', async () => { const r = await a.onClick?.(back, b); if (r !== false) close(); });
    foot.appendChild(b);
  }
  root.appendChild(back);
  return { el: back, close };
}

const selTunnel = () => S.tunnels.find((t) => t.id === S.selected) || null;
const isActive = (id) => S.active === id;

/* ---------------------------------------------------------------- sidebar */
const ICO_SHIELD = '<svg viewBox="0 0 24 24"><path d="M12 2.500l8 3v6c0 4.800-3.300 8.800-8 10-4.700-1.200-8-5.200-8-10v-6z" fill="none" stroke="currentColor" stroke-width="1.800" stroke-linejoin="round"/></svg>';

function renderSidebar() {
  const list = $('#tunnelList');
  if (!S.tunnels.length) { list.innerHTML = '<div class="side-empty">Ingen tunneler endnu</div>'; return; }
  list.innerHTML = '';
  for (const t of S.tunnels) {
    const b = document.createElement('button');
    b.className = `t-item${t.id === S.selected && S.view === 'dash' ? ' sel' : ''}${isActive(t.id) ? ' on' : ''}`;
    const host = (t.endpoint || '').replace(/:\d+$/, '');
    b.innerHTML = `<div class="t-ico">${ICO_SHIELD}</div><div class="t-meta"><div class="t-name">${esc(t.name)}</div><div class="t-sub">${isActive(t.id) ? 'Forbundet' : esc(host || 'Ingen endpoint')}</div></div>`;
    b.addEventListener('click', () => { S.selected = t.id; S.view = 'dash'; render(); });
    list.appendChild(b);
  }
}

/* ----------------------------------------------------------------- banners */
function renderBanners() {
  const b = $('#banners'); b.innerHTML = '';
  const add = (cls, html, btn) => {
    const d = document.createElement('div'); d.className = `banner ${cls}`;
    d.innerHTML = `<div class="grow">${html}</div>`;
    if (btn) { const x = document.createElement('button'); x.className = 'btn'; x.textContent = btn.label; x.addEventListener('click', btn.fn); if (btn.disabled) x.disabled = true; d.appendChild(x); }
    b.appendChild(d);
  };
  if (!S.wgInstalled) add('warn', '<b>WireGuard mangler.</b> PB VPN bruger den officielle WireGuard-tunnel til selve forbindelsen.', {
    label: S.wgInstalling ? 'Installerer…' : 'Installér WireGuard', disabled: S.wgInstalling,
    fn: async () => { S.wgInstalling = true; renderBanners(); const r = await api.installWireGuard(); S.wgInstalling = false; if (!r.ok) toast(r.error, 'error'); else toast('WireGuard er installeret', 'ok'); renderBanners(); },
  });
  else if (!S.isAdmin) add('warn', '<b>Kør som administrator.</b> Der kræves administratorrettigheder for at oprette tunneler (den installerede version beder automatisk om det).');
  if (S.update.state === 'ready') add('info', `<b>Opdatering ${esc(S.update.version || '')} er klar.</b> Genstart for at installere den.`, { label: 'Genstart og opdatér', fn: () => api.installUpdate() });
}

/* -------------------------------------------------------------- dashboard */
function renderDash() {
  const t = selTunnel();
  $('#viewEmpty').hidden = !(S.view === 'dash' && !S.tunnels.length);
  $('#viewDash').hidden = !(S.view === 'dash' && t);
  $('#viewSettings').hidden = S.view !== 'settings';
  $('#navSettings').classList.toggle('sel', S.view === 'settings');
  if (S.view !== 'dash' || !t) return;

  const on = isActive(t.id); const busy = !!S.busy && (S.busy === t.id || S.busy === 'x');
  $('#tName').textContent = t.name;
  $('#power').className = `power${on ? ' on' : ''}${busy ? ' busy' : ''}`;
  $('#statusDot').className = `dot${busy ? ' busy' : on ? ' on' : ''}`;
  $('#statusText').textContent = busy ? (on ? 'Afbryder…' : 'Forbinder…') : on ? 'Forbundet' : 'Ikke forbundet';
  document.body.classList.toggle('connected', !!S.active);
  const chip = (l, v) => (v ? `<span class="chip">${l}<b>${esc(v)}</b></span>` : '');
  $('#chips').innerHTML = chip('Endpoint', t.endpoint) + chip('IP', t.address) + chip('DNS', t.dns);
  renderStats();
}

function renderStats() {
  const t = selTunnel(); if (!t || S.view !== 'dash') return;
  const on = isActive(t.id); const s = on ? S.stats : null;
  $('#uptime').textContent = fmtDur(s ? s.uptime : 0);
  const d = fmtRate(s ? s.rxRate : 0); const u = fmtRate(s ? s.txRate : 0);
  $('#downNum').textContent = d.v; $('#downUnit').textContent = d.u;
  $('#upNum').textContent = u.v; $('#upUnit').textContent = u.u;
  $('#downTotal').textContent = s ? `Total ${fmtBytes(s.rx)}` : '–';
  $('#upTotal').textContent = s ? `Total ${fmtBytes(s.tx)}` : '–';

  const lat = s ? s.latency : null; const ln = $('#latNum');
  ln.textContent = !on ? '–' : lat == null ? 'Timeout' : lat < 10 ? lat.toFixed(1) : Math.round(lat);
  ln.className = `num ${on ? latClass(lat) : ''}`;
  const lv = S.hist.lat.filter((x) => x != null);
  $('#latSub').textContent = on && lv.length ? `Gns. ${Math.round(lv.reduce((a, b) => a + b, 0) / lv.length)} · Min ${Math.round(Math.min(...lv))}` : '–';

  const hist = on ? S.hist : { rx: [], tx: [], lat: [] };
  drawChart($('#cDown'), hist.rx, '#22d3ee', { minMax: 125000 });
  drawChart($('#cUp'), hist.tx, '#a78bfa', { minMax: 125000 });
  drawChart($('#cLat'), hist.lat, latColor(lat), { minMax: 50 });

  const row = (l, v) => `<div class="d-item"><div class="d-label">${l}</div><div class="d-val" title="${esc(v)}">${esc(v)}</div></div>`;
  $('#details').innerHTML =
    row('Seneste handshake', on && s ? fmtAgo(s.handshakeAgo) : '–') +
    row('Endpoint', (on && s && s.liveEndpoint) || t.endpoint || '–') +
    row('Tilladte IP\'er', t.allowedIps || '–') +
    row('DNS', t.dns || '–');
}

/* --------------------------------------------------------------- settings */
function renderSettings() {
  const st = S.settings; const el = $('#viewSettings');
  const tog = (k) => `<button class="toggle${st[k] ? ' on' : ''}" data-tog="${k}" role="switch" aria-checked="${!!st[k]}"></button>`;
  const u = S.update;
  const updText = { idle: 'Tjek for nye versioner', checking: 'Søger efter opdateringer…', current: 'Du har den nyeste version', available: `Henter version ${u.version || ''}…`, downloading: `Henter opdatering… ${u.percent || 0}%`, ready: `Version ${u.version || ''} er klar til installation`, error: u.message || 'Kunne ikke tjekke for opdateringer' }[u.state] || '';
  el.innerHTML = `
  <h1>Indstillinger</h1>
  <div class="s-group"><div class="s-title">Netværk</div><div class="card s-card">
    <div class="s-row"><div class="s-text"><b>DNS-server</b><span>Standard er Google DNS (8.8.8.8). Flere adskilles med komma.</span></div><input class="input" id="inDns" value="${esc(st.dns)}" spellcheck="false"></div>
    <div class="s-row"><div class="s-text"><b>Brug altid denne DNS</b><span>Overskriver DNS fra konfigurationsfilen. Slå fra for at bruge udbyderens DNS, hvis den har en.</span></div>${tog('forceDns')}</div>
    <div class="s-row"><div class="s-text"><b>Latency-mål</b><span>Host eller host:port der måles mod (TCP). Standard 8.8.8.8:53.</span></div><input class="input" id="inLat" value="${esc(st.latencyTarget)}" spellcheck="false"></div>
    <div class="s-row"><div class="s-text"><b>Hastighedsenhed</b><span>Hvordan upload og download vises.</span></div><div class="seg"><button data-unit="bits" class="${st.units !== 'bytes' ? 'on' : ''}">Mbit/s</button><button data-unit="bytes" class="${st.units === 'bytes' ? 'on' : ''}">MB/s</button></div></div>
  </div></div>
  <div class="s-group"><div class="s-title">Opførsel</div><div class="card s-card">
    <div class="s-row"><div class="s-text"><b>Start med Windows</b><span>Starter PB VPN i baggrunden ved login.</span></div>${tog('autoStart')}</div>
    <div class="s-row"><div class="s-text"><b>Forbind automatisk ved start</b><span>Genopretter den senest brugte tunnel.</span></div>${tog('autoConnect')}</div>
    <div class="s-row"><div class="s-text"><b>Afbryd når appen afsluttes</b><span>Lukker tunnelen, så du ikke glemmer, den kører.</span></div>${tog('disconnectOnQuit')}</div>
    <div class="s-row"><div class="s-text"><b>Minimér til systembakken</b><span>Luk-knappen skjuler vinduet i stedet for at afslutte.</span></div>${tog('minimizeToTray')}</div>
  </div></div>
  <div class="s-group"><div class="s-title">Opdateringer</div><div class="card s-card">
    <div class="s-row"><div class="s-text"><b>PB VPN ${esc(S.version)}</b><span id="updText">${esc(updText)}</span></div>
      ${u.state === 'downloading' ? `<div class="progress"><i style="width:${u.percent || 0}%"></i></div>` : u.state === 'ready' ? '<button class="btn primary" id="btnInstallUpd">Genstart og opdatér</button>' : '<button class="btn" id="btnCheckUpd">Søg efter opdatering</button>'}
    </div>
  </div></div>`;

  el.querySelectorAll('[data-tog]').forEach((b) => b.addEventListener('click', () => api.setSettings({ [b.dataset.tog]: !S.settings[b.dataset.tog] })));
  el.querySelectorAll('[data-unit]').forEach((b) => b.addEventListener('click', () => api.setSettings({ units: b.dataset.unit })));
  const bindText = (id, key) => {
    const i = $(id, el);
    const save = async () => { const r = await api.setSettings({ [key]: i.value }); if (!r.ok) { toast(r.error, 'error'); i.value = S.settings[key]; } else if (key === 'dns' && S.active) toast('DNS gælder næste gang du forbinder', 'info'); };
    i.addEventListener('change', save); i.addEventListener('keydown', (e) => { if (e.key === 'Enter') i.blur(); });
  };
  bindText('#inDns', 'dns'); bindText('#inLat', 'latencyTarget');
  $('#btnCheckUpd', el)?.addEventListener('click', async () => { const r = await api.checkUpdate(); if (!r.ok) toast(r.error, 'error'); });
  $('#btnInstallUpd', el)?.addEventListener('click', () => api.installUpdate());
}

/* ------------------------------------------------------------------ master */
function render() {
  if (!S.tunnels.some((t) => t.id === S.selected)) S.selected = S.active || (S.tunnels[0] && S.tunnels[0].id) || null;
  $('#verText').textContent = `Version ${S.version}`;
  $('#updDot').hidden = S.update.state !== 'ready';
  renderSidebar(); renderBanners(); renderDash();
  if (S.view === 'settings') renderSettings();
}

/* ------------------------------------------------------------------ import */
async function importOne(name, text) {
  const r = await api.importConf(name, text);
  if (r.ok) { S.selected = r.id; S.view = 'dash'; }
  return r;
}
async function importFiles(files) {
  let n = 0; const errs = [];
  for (const f of files) { const r = await importOne(f.name, f.text); if (r.ok) n++; else errs.push(`${f.name}: ${r.error}`); }
  if (n) toast(n === 1 ? 'Tunnel importeret' : `${n} tunneler importeret`, 'ok');
  errs.forEach((e) => toast(e, 'error'));
  render();
}

function openImport(prefill = '') {
  const body = document.createElement('div'); body.style.cssText = 'display:flex;flex-direction:column;gap:12px';
  body.innerHTML = `
    <div class="filezone" id="fz">Vælg .conf-fil(er) fra din computer</div>
    <input class="input" id="impName" placeholder="Navn (valgfrit)" maxlength="40">
    <textarea class="input" id="impText" spellcheck="false" placeholder="[Interface]&#10;PrivateKey = …&#10;Address = 10.0.0.2/32&#10;&#10;[Peer]&#10;PublicKey = …&#10;Endpoint = vpn.eksempel.dk:51820&#10;AllowedIPs = 0.0.0.0/0"></textarea>
    <div class="hint">DNS sættes automatisk til ${esc(S.settings.dns || '8.8.8.8')}, medmindre du ændrer det under Indstillinger. Nøgler gemmes krypteret.</div>
    <div class="err" id="impErr" hidden></div>`;
  $('#impText', body).value = prefill;
  const m = modal({
    title: 'Tilføj tunnel', subtitle: 'Indsæt konfigurationen eller vælg en fil.', body,
    actions: [
      { label: 'Annullér' },
      { label: 'Importér', cls: 'primary', onClick: async (back) => {
        const text = $('#impText', back).value; const err = $('#impErr', back);
        const r = await importOne($('#impName', back).value, text);
        if (!r.ok) { err.textContent = r.error; err.hidden = false; return false; }
        toast('Tunnel importeret', 'ok'); render(); return true;
      } },
    ],
  });
  $('#fz', body).addEventListener('click', async () => {
    const r = await api.pickFiles();
    if (r.ok && r.files.length) { m.close(); importFiles(r.files); }
  });
  setTimeout(() => $('#impText', body).focus(), 50);
}

/* ------------------------------------------------------------- tunnel ops */
async function togglePower() {
  const t = selTunnel(); if (!t || S.busy) return;
  const r = isActive(t.id) ? await api.disconnect() : await api.connect(t.id);
  if (!r.ok) toast(r.error, 'error');
}

async function openEditor() {
  const t = selTunnel(); if (!t) return;
  const r = await api.getConfig(t.id); if (!r.ok) return toast(r.error, 'error');
  const body = document.createElement('div'); body.style.cssText = 'display:flex;flex-direction:column;gap:12px';
  body.innerHTML = `<input class="input" id="edName" maxlength="40" value="${esc(r.name)}"><textarea class="input" id="edText" spellcheck="false" style="height:300px"></textarea><div class="hint">Indeholder din private nøgle – del den aldrig. Ændringer træder i kraft næste gang du forbinder.</div><div class="err" id="edErr" hidden></div>`;
  $('#edText', body).value = r.text;
  modal({ title: 'Rediger konfiguration', body, actions: [
    { label: 'Annullér' },
    { label: 'Gem', cls: 'primary', onClick: async (back) => {
      const res = await api.saveConfig(t.id, $('#edName', back).value, $('#edText', back).value);
      if (!res.ok) { const e = $('#edErr', back); e.textContent = res.error; e.hidden = false; return false; }
      toast(res.active ? 'Gemt – genforbind for at anvende ændringerne' : 'Gemt', 'ok'); return true;
    } },
  ] });
}

function confirmDelete() {
  const t = selTunnel(); if (!t) return;
  modal({ title: `Slet “${t.name}”?`, subtitle: 'Konfigurationen og dens nøgler fjernes fra PB VPN. Det kan ikke fortrydes.', body: '<div></div>', actions: [
    { label: 'Annullér' },
    { label: 'Slet', cls: 'danger', onClick: async () => { await api.remove(t.id); toast('Tunnel slettet'); } },
  ] });
}

/* ------------------------------------------------------------------- boot */
function applyState(st) { Object.assign(S, st); render(); if (S.view === 'settings') renderSettings(); }

async function boot() {
  document.querySelectorAll('[data-win]').forEach((b) => b.addEventListener('click', () => api.win(b.dataset.win)));
  $('#btnAdd').addEventListener('click', () => openImport());
  $('#emptyPick').addEventListener('click', async () => { const r = await api.pickFiles(); if (r.ok && r.files.length) importFiles(r.files); });
  $('#emptyPaste').addEventListener('click', () => openImport());
  $('#navSettings').addEventListener('click', () => { S.view = S.view === 'settings' ? 'dash' : 'settings'; render(); });
  $('#power').addEventListener('click', togglePower);
  $('#btnEdit').addEventListener('click', openEditor);
  $('#btnDelete').addEventListener('click', confirmDelete);
  $('#btnExport').addEventListener('click', async () => { const r = await api.exportConf(S.selected); if (r.ok) toast('Eksporteret', 'ok'); else if (!r.canceled) toast(r.error, 'error'); });

  // Træk og slip
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => { if (e.dataTransfer?.types?.includes('Files')) { dragDepth++; $('#dragOverlay').hidden = false; } });
  window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#dragOverlay').hidden = true; } });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', async (e) => {
    e.preventDefault(); dragDepth = 0; $('#dragOverlay').hidden = true;
    const files = [...(e.dataTransfer?.files || [])].filter((f) => /\.(conf|txt)$/i.test(f.name) && f.size < 100000);
    if (!files.length) return toast('Slip en .conf-fil', 'error');
    importFiles(await Promise.all(files.map(async (f) => ({ name: f.name, text: await f.text() }))));
  });

  // Indsæt direkte (Ctrl+V) hvis det ligner en WireGuard-konfiguration
  window.addEventListener('paste', (e) => {
    if (['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return;
    const txt = e.clipboardData?.getData('text') || '';
    if (/\[Interface]/i.test(txt) && /\[Peer]/i.test(txt)) { e.preventDefault(); openImport(txt); }
  });
  window.addEventListener('keydown', (e) => { if (e.ctrlKey && e.key.toLowerCase() === 'n') { e.preventDefault(); openImport(); } });
  window.addEventListener('resize', () => renderStats());

  api.onState(applyState);
  api.onStats((p) => {
    const prev = S.active; S.active = p.active; S.busy = p.busy; S.stats = p.active ? p : null;
    if (p.active) {
      if (prev !== p.active) S.hist = { rx: [], tx: [], lat: [] };
      const h = S.hist; h.rx.push(p.rxRate); h.tx.push(p.txRate); h.lat.push(p.latency);
      for (const k of ['rx', 'tx', 'lat']) if (h[k].length > HIST) h[k].shift();
    } else S.hist = { rx: [], tx: [], lat: [] };
    if (prev !== p.active) { if (p.active && !S.tunnels.some((t) => t.id === S.selected && false)) S.selected = p.active; render(); } else renderStats();
  });
  api.onUpdate((u) => { S.update = u; render(); if (S.view === 'settings') renderSettings(); });
  api.onToast((t) => toast(t.text, t.kind));

  applyState(await api.state());
}
boot();
