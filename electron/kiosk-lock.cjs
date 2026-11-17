/**
 * Kiosk lock-down: no Windows edge swipes (user, 16 Nov 2026).
 *
 * On a touch panel, a visitor swiping in from a screen edge opens Windows' own UI over the
 * exhibit: the notification centre from the right, Widgets / Task View from the left, the
 * taskbar from the bottom. Windows has one policy that turns all of them off, "Allow edge
 * swipe" (Computer Configuration > Administrative Templates > Windows Components > Edge
 * UI). Its own help text: disabled means "users will not be able to invoke any system UI by
 * swiping in from any screen edge". It is the registry value
 *
 *     HKLM\SOFTWARE\Policies\Microsoft\Windows\EdgeUI   AllowEdgeSwipe = 0 (DWORD)
 *
 * Writing it needs admin: the Policies keys are read-only to a standard user, the per-user
 * copy under HKCU included (measured 16 Nov 2026). So:
 *
 *   - On the first run on a PC, the app asks Windows ONCE for permission (one UAC prompt,
 *     answered by whoever sets the PC up) and writes it for the whole machine. It then
 *     never asks again, whatever the answer, so visitors never see a prompt: a marker in
 *     .cache/ records that it asked. Delete .cache/kiosk-lock.asked to be asked again.
 *   - kiosk-setup.bat in the repo root does the same by hand, can undo it, and can show
 *     the status. Use it if the prompt was declined.
 *   - It takes effect after the next sign-in or restart (Windows reads it at logon).
 *
 * Every launch reads the value (reading needs no rights) and logs the state to
 * .cache/autostart.log, so a museum PC can be checked without regedit.
 *
 * THE SWITCH: `"lockEdgeSwipes": false` in kiosk.local.json (the gitignored per-PC file
 * that also holds `autoStart`) means never touch this PC. It does not undo a lock that is
 * already there, because that needs admin too: run `kiosk-setup.bat undo` for that.
 */

const { execFile } = require('node:child_process');
const { appendFileSync, existsSync, mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { enabledOnThisPc } = require('./autostart.cjs');

const KEY = 'HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\EdgeUI';
const VALUE = 'AllowEdgeSwipe';

const run = (file, args) => new Promise((resolve) => {
  execFile(file, args, { windowsHide: true, encoding: 'utf8' }, (err, stdout, stderr) => {
    resolve({ ok: !err, code: err?.code ?? 0, out: String(stdout || ''), err: String(stderr || err?.message || '') });
  });
});

/** 0 = swipes off, 1 = on, null = not set. */
async function readPolicy(key) {
  const r = await run('reg', ['query', key, '/v', VALUE]);
  if (!r.ok) return null;
  const m = r.out.match(new RegExp(`${VALUE}\\s+REG_DWORD\\s+0x([0-9a-f]+)`, 'i'));
  return m ? parseInt(m[1], 16) : null;
}

/**
 * @param {object} o
 * @param {string} o.root
 * @param {boolean} [o.elevate=true]  false in tests: write directly, no UAC
 * @param {string} [o.key]            for tests only
 */
async function syncKioskLock({ root, elevate = true, key = KEY }) {
  const cache = join(root, '.cache');
  const log = (msg) => {
    try {
      mkdirSync(cache, { recursive: true });
      appendFileSync(join(cache, 'autostart.log'), `${new Date().toISOString()}  edge swipes: ${msg}\n`);
    } catch { /* never break the kiosk */ }
  };
  if (process.platform !== 'win32') return 'skipped (not Windows)';

  try {
    const now = await readPolicy(key);
    if (!enabledOnThisPc(root, 'lockEdgeSwipes')) {
      // Logged once per state, not every launch: the log is for humans.
      return now === 0 ? 'switched off here, but this PC is still locked (kiosk-setup.bat undo)' : 'switched off on this PC';
    }
    if (now === 0) return 'locked';

    const marker = join(cache, 'kiosk-lock.asked');
    if (existsSync(marker)) {
      const msg = 'NOT locked, and the one-time prompt was already used. Run kiosk-setup.bat as admin.';
      log(msg);
      return msg;
    }
    mkdirSync(cache, { recursive: true });
    writeFileSync(marker, `${new Date().toISOString()}\n`);   // ask once, whatever the answer

    const regArgs = ['add', key, '/v', VALUE, '/t', 'REG_DWORD', '/d', '0', '/f'];
    let r;
    if (elevate) {
      // One UAC prompt. -Wait so the result can be read back; a declined prompt throws.
      const list = regArgs.map((a) => `'${a.replace(/'/g, "''")}'`).join(',');
      r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `try { $p = Start-Process -FilePath reg.exe -ArgumentList ${list} -Verb RunAs -WindowStyle Hidden -Wait -PassThru; exit $p.ExitCode } catch { exit 1223 }`]);
    } else {
      r = await run('reg', regArgs);
    }
    const after = await readPolicy(key);
    const msg = after === 0
      ? 'locked for this PC; takes effect after the next sign-in or restart'
      : `NOT locked (${r.code === 1223 ? 'the permission prompt was declined' : (r.err.trim() || `exit ${r.code}`)}). Run kiosk-setup.bat as admin.`;
    log(msg);
    return msg;
  } catch (e) {
    log(`FAILED: ${e?.message ?? e}`);
    return 'failed';
  }
}

module.exports = { syncKioskLock, readPolicy, KEY, VALUE };
