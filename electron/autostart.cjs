/**
 * Auto-start at logon (user, 16 Nov 2026): the museum staff only switch the PC on, and the
 * kiosk opens by itself.
 *
 * The FIRST time the app runs on a PC it registers a Windows scheduled task, "KRAF HoloBox",
 * that starts this same Electron app every time this Windows user logs on. Every later run
 * checks the task is still there and still points at this folder (re-registering it if the
 * folder has moved), so it is safe to run on every launch and costs one schtasks call.
 *
 * THE SWITCH, for our own PCs: a file `kiosk.local.json` in the repo root (gitignored, so it
 * never reaches GitHub or the museum):
 *
 *     { "autoStart": false }
 *
 * false = never set it up on this PC, and remove it if it had been set up. No file, or
 * `true`, = the museum behaviour. Kept out of the tracked code on purpose: a switch flipped
 * in tracked code would be committed sooner or later and ship the museum a kiosk that no
 * longer starts itself.
 *
 * Why a scheduled task and not the Startup folder / Run key: the task can wait a few seconds
 * for the desktop to settle, keeps running on battery (it is a laptop), has no 72-hour time
 * limit, never starts a second copy, and restarts the app if it crashes. It runs as the
 * logged-on user with normal rights, so creating it needs NO admin (measured 16 Nov 2026 on
 * a standard account). If a locked-down PC refuses it anyway, it falls back to Electron's
 * own login item (the per-user Run key), which needs no rights at all.
 *
 * Every outcome is written to .cache/autostart.log, so a museum PC can be checked without
 * opening Task Scheduler.
 */

const { execFile } = require('node:child_process');
const { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const TASK = 'KRAF HoloBox';
const DELAY = 'PT15S';   // after logon: lets the desktop, display driver and GPU settle

const schtasks = (args) => new Promise((resolve) => {
  execFile('schtasks', args, { windowsHide: true, encoding: 'utf8' }, (err, stdout, stderr) => {
    resolve({ ok: !err, out: String(stdout || ''), err: String(stderr || err?.message || '') });
  });
});

const xmlEscape = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The switch. No file = on (the museum). A file that is there but does not parse still
 *  counts if it says `"autoStart": false`: Notepad and PowerShell save UTF-8 with a
 *  byte-order mark, and a stray comma is an easy slip, and either one made JSON.parse fail
 *  and the switch be silently ignored (found in testing, 16 Nov 2026). */
function enabledOnThisPc(root) {
  let text;
  try { text = readFileSync(join(root, 'kiosk.local.json'), 'utf8').replace(/^﻿/, ''); } catch { return true; }
  try { return JSON.parse(text).autoStart !== false; } catch { /* fall through */ }
  return !/"autoStart"\s*:\s*false/.test(text);
}

function taskXml({ user, command, args, workDir }) {
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Opens the KRAF HoloBox kiosk when this user logs on. Set up by the app itself on its first run; see electron/autostart.cjs.</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${xmlEscape(user)}</UserId>
      <Delay>${DELAY}</Delay>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${xmlEscape(user)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>false</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>5</Priority>
    <RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xmlEscape(command)}</Command>
      <Arguments>${xmlEscape(args)}</Arguments>
      <WorkingDirectory>${xmlEscape(workDir)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

/**
 * Make this PC match the switch. Never throws, never blocks the kiosk: call it after the
 * window is up and ignore the promise.
 *
 * @param {object} o
 * @param {string} o.root      the repo folder (the app path Electron is started with)
 * @param {string} o.exe       process.execPath: the electron.exe that is running now
 * @param {(on:boolean)=>void} [o.loginItem]  fallback: Electron's app.setLoginItemSettings
 * @param {string} [o.taskName] for tests only
 */
async function syncAutoStart({ root, exe, loginItem, taskName = TASK }) {
  const logDir = join(root, '.cache');
  const log = (msg) => {
    try {
      mkdirSync(logDir, { recursive: true });
      appendFileSync(join(logDir, 'autostart.log'), `${new Date().toISOString()}  ${msg}\n`);
    } catch { /* logging must never break the kiosk */ }
  };
  if (process.platform !== 'win32') return 'skipped (not Windows)';

  try {
    const existing = await schtasks(['/Query', '/TN', taskName, '/XML']);

    if (!enabledOnThisPc(root)) {
      let msg = 'switched off on this PC (kiosk.local.json)';
      if (existing.ok) {
        const del = await schtasks(['/Delete', '/TN', taskName, '/F']);
        msg += del.ok ? `; removed the existing "${taskName}" task` : `; could NOT remove "${taskName}": ${del.err.trim()}`;
      }
      loginItem?.(false);
      log(msg);
      return msg;
    }

    const args = `"${root}"`;
    // Up to date: the task exists and starts this exe on this folder. Compared on the XML's
    // own text, case-insensitively (Windows paths), so a moved folder is re-registered.
    const want = [exe, root].map((s) => xmlEscape(s).toLowerCase());
    if (existing.ok && want.every((s) => existing.out.toLowerCase().includes(s))) {
      return 'already set up';
    }

    const user = `${process.env.USERDOMAIN || ''}${process.env.USERDOMAIN ? '\\' : ''}${process.env.USERNAME || ''}`;
    // schtasks wants the XML as UTF-16 LE with a byte-order mark.
    const file = join(tmpdir(), `kraf-autostart-${process.pid}.xml`);
    const xml = taskXml({ user, command: exe, args, workDir: root });
    writeFileSync(file, Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(xml, 'utf16le')]));
    const made = await schtasks(['/Create', '/TN', taskName, '/XML', file, '/F']);
    try { unlinkSync(file); } catch { /* temp file */ }

    if (made.ok) {
      loginItem?.(false);   // one mechanism only, or the app would be started twice
      const msg = `${existing.ok ? 're-registered (folder or exe moved)' : 'set up for the first time'}: task "${taskName}" for ${user} -> ${exe} ${args}`;
      log(msg);
      return msg;
    }

    // Locked-down PC: fall back to the per-user Run key, which needs no rights.
    if (loginItem) {
      loginItem(true);
      const msg = `scheduled task refused (${made.err.trim()}); using the Windows login item instead`;
      log(msg);
      return msg;
    }
    log(`FAILED: ${made.err.trim()}`);
    return 'failed';
  } catch (e) {
    log(`FAILED: ${e?.message ?? e}`);
    return 'failed';
  }
}

module.exports = { syncAutoStart, enabledOnThisPc, TASK };
