/**
 * KRAF kiosk — Electron main process.
 *
 * Why this exists rather than "just Chrome":
 *
 *   - Chromium is BUNDLED and version-pinned. The browser build cannot update itself
 *     mid-exhibition and change behaviour under the museum's feet, and the machine
 *     does not need Chrome installed at all.
 *   - No browser UI of any kind: no address bar, no Google Translate offer, no
 *     "restore pages?" bubble, no profile picker.
 *   - Real window control — exact portrait size, true fullscreen, and a guaranteed
 *     F11 binding instead of fighting the browser for the key.
 *   - The display is kept awake without touching Windows power settings.
 *
 * The web app itself is unchanged: this loads the same http://127.0.0.1 server that
 * start.bat uses, so nothing about the content pipeline differs.
 */

// CommonJS on purpose: Electron 33's ESM interop fails on `import ... from 'electron'`,
// and the main process gains nothing from ESM. The renderer (web/) stays ESM.
const { app, BrowserWindow, globalShortcut, ipcMain, powerSaveBlocker, screen, shell } = require('electron');
const { spawn } = require('node:child_process');
const { readFileSync } = require('node:fs');
const { createConnection } = require('node:net');
const { join, resolve } = require('node:path');

// Esc on the main menu asks the shell to close the app (see electron/preload.cjs).
ipcMain.on('kraf:quit', () => app.quit());

const ROOT = resolve(__dirname, '..');
const PORT = Number(process.env.KRAF_PORT ?? 8765);
const URL_ = `http://127.0.0.1:${PORT}/`;

const kiosk = (() => {
  try {
    const j = JSON.parse(readFileSync(join(ROOT, 'content', 'content.json'), 'utf8'));
    return j.kiosk ?? {};
  } catch { return {}; }
})();

const WIN_W = kiosk.windowedWidth ?? 608;
const WIN_H = kiosk.windowedHeight ?? 1080;

let server = null;
let win = null;
let blockerId = null;

/* ------------------------------------------------------------------ server */

const portOpen = () => new Promise((res) => {
  const s = createConnection({ port: PORT, host: '127.0.0.1' })
    .on('connect', () => { s.destroy(); res(true); })
    .on('error', () => res(false));
});

async function startServer() {
  if (await portOpen()) return;          // already running (e.g. started by start.bat)
  server = spawn(process.execPath, [join(ROOT, 'server', 'server.js')], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', KRAF_PORT: String(PORT) },
    stdio: 'ignore',
    windowsHide: true,
  });
  for (let i = 0; i < 100; i++) {
    if (await portOpen()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server did not start on ${PORT}`);
}

/* ------------------------------------------------------------------ window */

function createWindow() {
  const area = screen.getPrimaryDisplay().workAreaSize;

  win = new BrowserWindow({
    width: WIN_W,
    height: WIN_H,
    x: Math.max(0, Math.round((area.width - WIN_W) / 2)),
    y: Math.max(0, Math.round((area.height - WIN_H) / 2)),
    backgroundColor: '#FCFCFF',
    show: false,
    frame: false,
    fullscreen: true,
    autoHideMenuBar: true,
    webPreferences: {
      // The page is local, trusted content and talks to nothing but 127.0.0.1.
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,   // keep the idle loop running if focus is lost
      spellcheck: false,
    },
  });

  win.setMenu(null);
  win.once('ready-to-show', () => win.show());
  win.loadURL(URL_);

  // Nothing in this app should ever open a second window or navigate away.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\/(127\.0\.0\.1|localhost)/.test(url)) return { action: 'allow' };
    shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(URL_)) e.preventDefault();
  });

  // A renderer crash on an unattended kiosk should recover itself, not sit dead.
  win.webContents.on('render-process-gone', () => win?.reload());
  win.on('unresponsive', () => win?.reload());
}

/** F11: fullscreen <-> the portrait window, with the window re-centred either way. */
function toggleFullscreen() {
  if (!win) return;
  const next = !win.isFullScreen();
  win.setFullScreen(next);
  if (!next) {
    const area = screen.getPrimaryDisplay().workAreaSize;
    win.setBounds({
      width: WIN_W,
      height: WIN_H,
      x: Math.max(0, Math.round((area.width - WIN_W) / 2)),
      y: Math.max(0, Math.round((area.height - WIN_H) / 2)),
    });
  }
}

/* ------------------------------------------------------------------ boot */

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('disable-pinch');
// Hardware acceleration is deliberately left ON: video decode and WebGL both need it.

app.whenReady().then(async () => {
  try {
    await startServer();
  } catch (err) {
    console.error(err);
  }

  createWindow();

  // Keep the panel awake without changing the machine's power settings.
  blockerId = powerSaveBlocker.start('prevent-display-sleep');

  globalShortcut.register('F11', toggleFullscreen);
  globalShortcut.register('CommandOrControl+R', () => win?.reload());
  globalShortcut.register('CommandOrControl+Shift+I', () => win?.webContents.toggleDevTools());

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => app.quit());

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (blockerId !== null && powerSaveBlocker.isStarted(blockerId)) powerSaveBlocker.stop(blockerId);
  if (server && !server.killed) server.kill();
});
