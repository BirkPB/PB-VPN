'use strict';
const {
  app, BrowserWindow, ipcMain, Tray, Menu, dialog, nativeImage, shell, safeStorage,
} = require('electron');
const path = require('path');
const fs = require('fs');
const net = require('net');
const https = require('https');
const crypto = require('crypto');
const { execFile } = require('child_process');

const isDev = !app.isPackaged;
const PF = process.env.ProgramFiles || 'C:\\Program Files';
const WG_DIR = path.join(PF, 'WireGuard');
const WIREGUARD = path.join(WG_DIR, 'wireguard.exe');
const WG = path.join(WG_DIR, 'wg.exe');
const RUN_DIR = path.join(process.env.ProgramData || 'C:\\ProgramData', 'PB-VPN', 'run');

const DEFAULT_SETTINGS = {
  dns: '8.8.8.8',
  forceDns: true,
  latencyTarget: '8.8.8.8',
  units: 'bits',
  autoStart: false,
  autoConnect: false,
  lastTunnel: null,
  disconnectOnQuit: true,
  minimizeToTray: true,
};

let win = null;
let tray = null;
let quitting = false;
let settings = { ...DEFAULT_SETTINGS };
let library = { tunnels: [] };
let isAdmin = false;
let wgInstalled = false;
let busy = null; // id på tunnel der skifter tilstand
const startHidden = process.argv.includes('--hidden');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
}

/* ------------------------------------------------------------------ utils */
function run(file, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: 20000, ...opts }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || ''), err });
    });
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const userFile = (n) => path.join(app.getPath('userData'), n);

/* ---------------------------------------------------------------- storage */
function loadSettings() {
  try { settings = { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(userFile('settings.json'), 'utf8')) }; } catch { /* default */ }
}
function saveSettings() {
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  fs.writeFileSync(userFile('settings.json'), JSON.stringify(settings, null, 2));
}
function loadLibrary() {
  try {
    const raw = fs.readFileSync(userFile('library.bin'));
    const txt = safeStorage.isEncryptionAvailable() && raw[0] !== 0x7b ? safeStorage.decryptString(raw) : raw.toString('utf8');
    library = JSON.parse(txt);
    if (!Array.isArray(library.tunnels)) library = { tunnels: [] };
  } catch { library = { tunnels: [] }; }
}
function saveLibrary() {
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  const txt = JSON.stringify(library);
  // Private nøgler gemmes krypteret med Windows DPAPI (via safeStorage)
  const data = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(txt) : Buffer.from(txt, 'utf8');
  fs.writeFileSync(userFile('library.bin'), data);
}

/* ------------------------------------------------------------ config logic */
function parseConf(text) {
  const out = { iface: {}, peers: [] };
  let cur = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/[#;].*$/, '').trim();
    if (!line) continue;
    const sec = /^\[(.+)]$/.exec(line);
    if (sec) {
      const name = sec[1].toLowerCase();
      if (name === 'interface') cur = out.iface;
      else if (name === 'peer') { cur = {}; out.peers.push(cur); } else cur = null;
      continue;
    }
    const kv = /^([A-Za-z]+)\s*=\s*(.*)$/.exec(line);
    if (!kv || !cur) continue;
    const k = kv[1].toLowerCase();
    cur[k] = cur[k] ? `${cur[k]}, ${kv[2].trim()}` : kv[2].trim();
  }
  return out;
}

function validateConf(text) {
  const errors = [];
  if (!text || !text.trim()) return ['Konfigurationen er tom.'];
  const c = parseConf(text);
  const b64 = /^[A-Za-z0-9+/]{43}=$/;
  if (!c.iface.privatekey) errors.push('Mangler PrivateKey under [Interface].');
  else if (!b64.test(c.iface.privatekey)) errors.push('PrivateKey er ikke en gyldig WireGuard-nøgle.');
  if (!c.iface.address) errors.push('Mangler Address under [Interface].');
  if (!c.peers.length) errors.push('Mangler en [Peer]-sektion.');
  c.peers.forEach((p, i) => {
    if (!p.publickey || !b64.test(p.publickey)) errors.push(`Peer ${i + 1}: PublicKey mangler eller er ugyldig.`);
    if (!p.allowedips) errors.push(`Peer ${i + 1}: Mangler AllowedIPs.`);
  });
  return errors;
}

const DNS_RE = /^\s*([0-9a-fA-F:.]+)(\s*,\s*[0-9a-fA-F:.]+)*\s*$/;

/** Sætter DNS (standard 8.8.8.8) i [Interface] */
function applyDns(text) {
  const dns = settings.dns && DNS_RE.test(settings.dns) ? settings.dns.trim() : '8.8.8.8';
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let inIface = false; let ifaceIdx = -1; let hasDns = false;
  const out = [];
  for (const line of lines) {
    const sec = /^\s*\[(.+)]\s*$/.exec(line);
    if (sec) { inIface = sec[1].toLowerCase() === 'interface'; if (inIface && ifaceIdx < 0) ifaceIdx = out.length; }
    if (inIface && /^\s*DNS\s*=/i.test(line)) {
      hasDns = true;
      if (settings.forceDns) { out.push(`DNS = ${dns}`); continue; }
    }
    out.push(line);
  }
  if (!hasDns && ifaceIdx >= 0) out.splice(ifaceIdx + 1, 0, `DNS = ${dns}`);
  return out.join('\r\n');
}

function nameToId() { return `pb${crypto.randomBytes(4).toString('hex')}`; }

function publicTunnel(t) {
  const c = parseConf(t.conf);
  const p = c.peers[0] || {};
  return {
    id: t.id, name: t.name, addedAt: t.addedAt,
    endpoint: p.endpoint || '', address: c.iface.address || '',
    allowedIps: c.peers.map((x) => x.allowedips).filter(Boolean).join(', '),
    dns: settings.forceDns ? settings.dns : (c.iface.dns || settings.dns),
    peers: c.peers.length,
  };
}

/* ------------------------------------------------------------ WireGuard */
async function detectEnv() {
  wgInstalled = fs.existsSync(WIREGUARD) && fs.existsSync(WG);
  isAdmin = (await run('fltmc.exe', [])).code === 0;
}

async function activeInterfaces() {
  if (!wgInstalled) return [];
  const r = await run(WG, ['show', 'interfaces']);
  if (r.code !== 0) return [];
  const names = r.stdout.trim().split(/\s+/).filter(Boolean);
  return library.tunnels.filter((t) => names.includes(t.id)).map((t) => t.id);
}

function lockRunDir() {
  fs.mkdirSync(RUN_DIR, { recursive: true });
  // Kun SYSTEM og Administratorer (SID'er, så det virker på alle sprog)
  return run('icacls.exe', [RUN_DIR, '/inheritance:r', '/grant:r', '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F']);
}

async function waitFor(fn, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await sleep(300); }
  return false;
}

async function connect(id) {
  if (!wgInstalled) return { ok: false, error: 'WireGuard er ikke installeret.' };
  if (!isAdmin) return { ok: false, error: 'PB VPN skal køres som administrator.' };
  const t = library.tunnels.find((x) => x.id === id);
  if (!t) return { ok: false, error: 'Tunnel findes ikke.' };
  if (busy) return { ok: false, error: 'Vent et øjeblik…' };
  busy = id; pushState();
  try {
    for (const a of await activeInterfaces()) await rawDisconnect(a);
    await lockRunDir();
    const file = path.join(RUN_DIR, `${id}.conf`);
    fs.writeFileSync(file, applyDns(t.conf));
    const r = await run(WIREGUARD, ['/installtunnelservice', file]);
    if (r.code !== 0) { try { fs.unlinkSync(file); } catch { /* */ } return { ok: false, error: (r.stderr || r.stdout || 'Kunne ikke starte tunnelen.').trim() }; }
    const up = await waitFor(async () => (await activeInterfaces()).includes(id), 12000);
    if (!up) { await rawDisconnect(id); return { ok: false, error: 'Tunnelen startede ikke. Tjek din konfiguration.' }; }
    connectedAt = Date.now(); lastSample = null;
    settings.lastTunnel = id; saveSettings();
    return { ok: true };
  } finally { busy = null; pushState(); }
}

async function rawDisconnect(id) {
  await run(WIREGUARD, ['/uninstalltunnelservice', id]);
  await waitFor(async () => !(await activeInterfaces()).includes(id), 8000);
  try { fs.unlinkSync(path.join(RUN_DIR, `${id}.conf`)); } catch { /* */ }
}

async function disconnect() {
  if (busy) return { ok: false, error: 'Vent et øjeblik…' };
  busy = 'x'; pushState();
  try { for (const a of await activeInterfaces()) await rawDisconnect(a); connectedAt = null; lastSample = null; return { ok: true }; } finally { busy = null; pushState(); }
}

/* ----------------------------------------------------------------- stats */
let connectedAt = null;
let lastSample = null;
let ticking = false;

function parseDump(out) {
  const lines = out.trim().split('\n').filter(Boolean);
  let rx = 0; let tx = 0; let handshake = 0; let endpoint = '';
  for (const l of lines.slice(1)) {
    const f = l.split('\t');
    if (f.length < 8) continue;
    endpoint = endpoint || (f[2] !== '(none)' ? f[2] : '');
    handshake = Math.max(handshake, Number(f[4]) || 0);
    rx += Number(f[5]) || 0; tx += Number(f[6]) || 0;
  }
  return { rx, tx, handshake, endpoint };
}

function tcpPing(target, timeout = 1500) {
  return new Promise((resolve) => {
    let host = target || '8.8.8.8'; let port = 53;
    const m = /^(.+):(\d{1,5})$/.exec(host);
    if (m && !host.includes('::')) { host = m[1]; port = Number(m[2]); }
    const t0 = process.hrtime.bigint();
    const s = net.connect({ host, port });
    let done = false;
    const fin = (v) => { if (done) return; done = true; s.destroy(); resolve(v); };
    s.setTimeout(timeout, () => fin(null));
    s.once('connect', () => fin(Number(process.hrtime.bigint() - t0) / 1e6));
    s.once('error', () => fin(null));
  });
}

async function tick() {
  if (ticking) return; ticking = true;
  try {
    const active = (await activeInterfaces())[0] || null;
    const payload = { active, busy, t: Date.now() };
    if (active) {
      if (!connectedAt) connectedAt = Date.now();
      const [d, lat] = await Promise.all([run(WG, ['show', active, 'dump']), tcpPing(settings.latencyTarget)]);
      const s = parseDump(d.stdout);
      const now = Date.now();
      let rxRate = 0; let txRate = 0;
      if (lastSample && s.rx >= lastSample.rx && s.tx >= lastSample.tx) {
        const dt = (now - lastSample.t) / 1000 || 1;
        rxRate = (s.rx - lastSample.rx) / dt; txRate = (s.tx - lastSample.tx) / dt;
      }
      lastSample = { rx: s.rx, tx: s.tx, t: now };
      Object.assign(payload, {
        rx: s.rx, tx: s.tx, rxRate, txRate, latency: lat,
        handshakeAgo: s.handshake ? Math.max(0, Math.floor(now / 1000 - s.handshake)) : null,
        liveEndpoint: s.endpoint, uptime: Math.floor((now - connectedAt) / 1000),
      });
    } else { connectedAt = null; lastSample = null; }
    send('stats', payload);
    updateTray(active);
  } finally { ticking = false; }
}

/* ---------------------------------------------------------------- window */
function send(ch, data) { if (win && !win.isDestroyed()) win.webContents.send(ch, data); }

function publicState() {
  return {
    tunnels: library.tunnels.map(publicTunnel), settings, wgInstalled, isAdmin,
    version: app.getVersion(), busy, packaged: !isDev,
  };
}
function pushState() { send('state', publicState()); }

function createWindow() {
  win = new BrowserWindow({
    width: 1120, height: 740, minWidth: 940, minHeight: 640,
    frame: false, show: false, backgroundColor: '#07080f', title: 'PB VPN',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false },
  });
  win.removeMenu();
  win.loadFile(path.join(__dirname, 'src', 'index.html'));
  win.once('ready-to-show', () => { if (!startHidden) win.show(); });
  win.on('close', (e) => { if (!quitting && settings.minimizeToTray) { e.preventDefault(); win.hide(); } });
  win.on('maximize', () => send('maximized', true));
  win.on('unmaximize', () => send('maximized', false));
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
}

function showWindow() { if (!win) return; if (win.isMinimized()) win.restore(); win.show(); win.focus(); }

function createTray() {
  const img = nativeImage.createFromPath(path.join(__dirname, 'build', 'icon.png')).resize({ width: 16, height: 16 });
  tray = new Tray(img);
  tray.setToolTip('PB VPN');
  tray.on('click', showWindow);
  updateTray(null, true);
}
let lastTrayKey = '';
function updateTray(active, force) {
  if (!tray) return;
  const key = `${active}|${busy}|${library.tunnels.map((t) => t.id + t.name).join()}`;
  if (key === lastTrayKey && !force) return; lastTrayKey = key;
  const items = [{ label: 'Åbn PB VPN', click: showWindow }, { type: 'separator' }];
  for (const t of library.tunnels) {
    items.push({
      label: t.name, type: 'checkbox', checked: t.id === active,
      click: () => (t.id === active ? disconnect() : connect(t.id)),
    });
  }
  if (library.tunnels.length) items.push({ type: 'separator' });
  items.push({ label: 'Afslut', click: () => { app.quit(); } });
  tray.setContextMenu(Menu.buildFromTemplate(items));
  tray.setToolTip(active ? `PB VPN – forbundet (${(library.tunnels.find((t) => t.id === active) || {}).name})` : 'PB VPN – ikke forbundet');
}

/* ---------------------------------------------------------------- startup */
async function setAutoStart(on) {
  const exe = process.execPath;
  if (isDev) return;
  if (on) await run('schtasks.exe', ['/create', '/tn', 'PB VPN', '/tr', `"${exe}" --hidden`, '/sc', 'onlogon', '/rl', 'highest', '/f']);
  else await run('schtasks.exe', ['/delete', '/tn', 'PB VPN', '/f']);
}

/* ------------------------------------------------------- install WireGuard */
function installWireGuard() {
  return new Promise((resolve) => {
    const dest = path.join(app.getPath('temp'), 'wireguard-installer.exe');
    const f = fs.createWriteStream(dest);
    https.get('https://download.wireguard.com/windows-client/wireguard-installer.exe', (res) => {
      if (res.statusCode !== 200) { f.close(); return resolve({ ok: false, error: `Download fejlede (${res.statusCode}).` }); }
      res.pipe(f);
      f.on('finish', () => f.close(async () => {
        send('wg-install', 'installing');
        // Den officielle bootstrapper henter og verificerer selv den signerede MSI
        await run(dest, [], { timeout: 300000 });
        try { fs.unlinkSync(dest); } catch { /* */ }
        await detectEnv(); pushState();
        resolve(wgInstalled ? { ok: true } : { ok: false, error: 'Installationen blev ikke gennemført.' });
      }));
    }).on('error', (e) => resolve({ ok: false, error: e.message }));
  });
}

/* ---------------------------------------------------------------- updater */
let updater = null;
function setupUpdater() {
  if (isDev) return;
  try {
    ({ autoUpdater: updater } = require('electron-updater'));
  } catch { return; }
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;
  const u = (state, extra = {}) => send('update', { state, ...extra });
  updater.on('checking-for-update', () => u('checking'));
  updater.on('update-available', (i) => u('available', { version: i.version }));
  updater.on('update-not-available', () => u('current'));
  updater.on('download-progress', (p) => u('downloading', { percent: Math.round(p.percent) }));
  updater.on('update-downloaded', (i) => u('ready', { version: i.version }));
  updater.on('error', (e) => u('error', { message: String((e && e.message) || e).split('\n')[0].slice(0, 160) }));
  setTimeout(() => updater.checkForUpdates().catch(() => {}), 5000);
  setInterval(() => updater.checkForUpdates().catch(() => {}), 4 * 3600 * 1000);
}

/* -------------------------------------------------------------------- IPC */
function uniqueName(base) {
  let n = base; let i = 2;
  while (library.tunnels.some((t) => t.name.toLowerCase() === n.toLowerCase())) n = `${base} ${i++}`;
  return n;
}

function registerIpc() {
  const h = (ch, fn) => ipcMain.handle(ch, async (_e, ...a) => { try { return await fn(...a); } catch (e) { return { ok: false, error: String(e.message || e) }; } });

  h('state', () => publicState());

  h('import', (name, text) => {
    text = String(text || '').trim();
    const errors = validateConf(text);
    if (errors.length) return { ok: false, error: errors.join(' ') };
    const base = String(name || '').replace(/\.conf$/i, '').trim().slice(0, 40) || 'Ny tunnel';
    const t = { id: nameToId(), name: uniqueName(base), conf: text.replace(/\r\n/g, '\n'), addedAt: Date.now() };
    library.tunnels.push(t); saveLibrary(); pushState();
    return { ok: true, id: t.id };
  });

  h('get-config', (id) => { const t = library.tunnels.find((x) => x.id === id); return t ? { ok: true, text: t.conf, name: t.name } : { ok: false, error: 'Ikke fundet' }; });

  h('save-config', async (id, name, text) => {
    const t = library.tunnels.find((x) => x.id === id);
    if (!t) return { ok: false, error: 'Ikke fundet' };
    const errors = validateConf(text);
    if (errors.length) return { ok: false, error: errors.join(' ') };
    const nm = String(name || '').trim().slice(0, 40);
    if (nm && nm.toLowerCase() !== t.name.toLowerCase()) {
      if (library.tunnels.some((x) => x.id !== id && x.name.toLowerCase() === nm.toLowerCase())) return { ok: false, error: 'Navnet er allerede i brug.' };
      t.name = nm;
    }
    t.conf = String(text).trim().replace(/\r\n/g, '\n');
    saveLibrary(); pushState();
    return { ok: true, active: (await activeInterfaces()).includes(id) };
  });

  h('delete', async (id) => {
    if ((await activeInterfaces()).includes(id)) await disconnect();
    library.tunnels = library.tunnels.filter((t) => t.id !== id);
    if (settings.lastTunnel === id) { settings.lastTunnel = null; saveSettings(); }
    saveLibrary(); pushState();
    return { ok: true };
  });

  h('export', async (id) => {
    const t = library.tunnels.find((x) => x.id === id);
    if (!t) return { ok: false, error: 'Ikke fundet' };
    const r = await dialog.showSaveDialog(win, { defaultPath: `${t.name}.conf`, filters: [{ name: 'WireGuard', extensions: ['conf'] }] });
    if (r.canceled || !r.filePath) return { ok: false, canceled: true };
    fs.writeFileSync(r.filePath, t.conf.replace(/\n/g, '\r\n'));
    return { ok: true };
  });

  h('pick-files', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'], filters: [{ name: 'WireGuard konfiguration', extensions: ['conf', 'txt'] }] });
    if (r.canceled) return { ok: true, files: [] };
    return { ok: true, files: r.filePaths.slice(0, 50).map((p) => ({ name: path.basename(p), text: fs.readFileSync(p, 'utf8').slice(0, 100000) })) };
  });

  h('connect', (id) => connect(id));
  h('disconnect', () => disconnect());

  h('set-settings', async (patch) => {
    const next = { ...settings };
    if (typeof patch.dns === 'string') { if (!DNS_RE.test(patch.dns)) return { ok: false, error: 'Ugyldig DNS-adresse.' }; next.dns = patch.dns.trim(); }
    if (typeof patch.latencyTarget === 'string') next.latencyTarget = patch.latencyTarget.trim().slice(0, 100) || '8.8.8.8';
    for (const k of ['forceDns', 'autoStart', 'autoConnect', 'disconnectOnQuit', 'minimizeToTray']) if (typeof patch[k] === 'boolean') next[k] = patch[k];
    if (patch.units === 'bits' || patch.units === 'bytes') next.units = patch.units;
    const autoChanged = next.autoStart !== settings.autoStart;
    settings = next; saveSettings();
    if (autoChanged) await setAutoStart(settings.autoStart);
    pushState();
    return { ok: true };
  });

  h('install-wireguard', () => installWireGuard());
  h('check-update', async () => {
    if (!updater) return { ok: false, error: isDev ? 'Opdatering er kun aktiv i den installerede version.' : 'Opdatering utilgængelig.' };
    try { await updater.checkForUpdates(); return { ok: true }; } catch (e) { return { ok: false, error: String(e.message || e).split('\n')[0] }; }
  });
  h('install-update', () => { if (updater) { quitting = true; updater.quitAndInstall(false, true); } return { ok: true }; });
  h('open-external', (url) => { if (/^https:\/\//.test(url)) shell.openExternal(url); return { ok: true }; });

  ipcMain.on('win', (_e, a) => {
    if (!win) return;
    if (a === 'min') win.minimize();
    else if (a === 'max') (win.isMaximized() ? win.unmaximize() : win.maximize());
    else if (a === 'close') win.close();
  });
}

/* ------------------------------------------------------------------- boot */
app.whenReady().then(async () => {
  app.setAppUserModelId('dk.pbvpn.client');
  loadSettings(); loadLibrary(); await detectEnv();
  registerIpc(); createWindow(); createTray(); setupUpdater();
  setInterval(tick, 1000); tick();
  if (settings.autoConnect && settings.lastTunnel && library.tunnels.some((t) => t.id === settings.lastTunnel)) {
    connect(settings.lastTunnel).then((r) => { if (!r.ok) send('toast', { kind: 'error', text: r.error }); });
  }
});

app.on('before-quit', async (e) => {
  if (quitting) return;
  quitting = true;
  if (settings.disconnectOnQuit && wgInstalled && isAdmin) {
    e.preventDefault();
    try { for (const a of await activeInterfaces()) await rawDisconnect(a); } catch { /* */ }
    app.quit();
  }
});
app.on('window-all-closed', () => { /* kører videre i tray */ });
