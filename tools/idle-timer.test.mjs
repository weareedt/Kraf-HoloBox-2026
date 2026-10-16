/**
 * Reproduce the reported fault, then prove it is fixed.
 *
 * Reported: watching Norhaiza's 7m22s profile, the kiosk jumped to the MAIN MENU partway
 * through. The cause is a release from one screen decrementing another screen's hold:
 *
 *   enterArtist   hold()            holds 1, release scheduled for the walk-in's 14.96 s
 *   tap Profil    clearHolds()      holds 0   (showScreen does this on every change)
 *   enterTalk     hold()            holds 1
 *   t = 14.06 s   stray release()   holds 0   <- the talk is now unprotected
 *   t = 3 min     onIdle fires      -> main menu, mid-talk
 */
import { IdleTimer } from '../web/lib/idle-timer.js';

let now = 0;
const scheduled = [];
globalThis.window = { addEventListener() {}, removeEventListener() {} };
globalThis.setTimeout = (fn, ms) => { const h = { fn, at: now + ms, dead: false }; scheduled.push(h); return h; };
globalThis.clearTimeout = (h) => { if (h) h.dead = true; };
const advance = (ms) => {
  const until = now + ms;
  for (;;) {
    const next = scheduled.filter((h) => !h.dead && h.at <= until).sort((a, b) => a.at - b.at)[0];
    if (!next) break;
    now = next.at;
    next.dead = true;
    next.fn();
  }
  now = until;
};

const TIMEOUT = 180_000;       // kiosk.idleTimeoutMs
const WALK = 14_960;           // norhaiza walk durationMs
const PROFILE = 442_700;       // her profile is 7m22s

let wentToMenu = false;
const idle = new IdleTimer(TIMEOUT, () => { wentToMenu = true; });
idle.start();

// enterArtist with walkIn: holds, and schedules its release on a timer
const releaseWalk = idle.hold();
setTimeout(releaseWalk, Math.max(800, WALK - 900));

// the visitor taps Profil 2 s in, while the walk-in is still playing
advance(2_000);
idle.clearHolds();             // showScreen('profile')
const releaseTalk = idle.hold();   // enterTalk

// now play the whole profile through, with nobody touching the screen
advance(PROFILE);

console.log(`  walk-in ${WALK} ms, profile ${PROFILE} ms, idle timeout ${TIMEOUT} ms`);
console.log(`  tapped Profil 2 s into the walk-in, then did not touch the screen`);
console.log(`  holds at end of talk: ${idle.holds}`);
console.log(`  bounced to main menu mid-talk: ${wentToMenu ? 'YES  <-- BUG' : 'no'}`);

// and the countdown must resume once the talk ends
releaseTalk();
wentToMenu = false;
advance(TIMEOUT + 1_000);
console.log(`  after the talk ends, idle still works: ${wentToMenu ? 'yes' : 'NO  <-- would never return'}`);

process.exit(wentToMenu && idle.holds === 0 ? 0 : 1);
