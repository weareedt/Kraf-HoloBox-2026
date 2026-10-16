/**
 * Kiosk idle watchdog.
 *
 * One subtlety worth stating, because getting it wrong is silent and fatal:
 * the countdown is suspended only while a NON-LOOPING video is playing (the walk-in,
 * a profile, a process step). The artist idle loop must NOT suspend it — it runs
 * forever, so if it held the timer the kiosk would never return to the menu.
 */

export class IdleTimer {
  /**
   * @param {number} timeoutMs
   * @param {() => void} onIdle
   */
  constructor(timeoutMs, onIdle) {
    this.timeoutMs = timeoutMs;
    this.onIdle = onIdle;
    this.holds = 0;
    this.generation = 0;
    this.timer = null;
    this.enabled = false;

    this._bump = () => this.reset();
    for (const ev of ['pointerdown', 'touchstart', 'keydown', 'wheel']) {
      window.addEventListener(ev, this._bump, { passive: true, capture: true });
    }
  }

  start() {
    this.enabled = true;
    this.reset();
  }

  stop() {
    this.enabled = false;
    clearTimeout(this.timer);
    this.timer = null;
  }

  reset() {
    clearTimeout(this.timer);
    this.timer = null;
    if (!this.enabled || this.holds > 0) return;
    this.timer = setTimeout(() => this.onIdle(), this.timeoutMs);
  }

  /**
   * Suspend the countdown (a non-looping video started).
   *
   * @returns {() => void} the matching release. It is idempotent, and it is scoped to the
   *   screen it was taken on: once `clearHolds` has run, calling it does nothing.
   *
   * BOTH of those properties are load-bearing, and the second one fixed a real bug. The
   * walk-in takes a hold and schedules its release on a timer for the clip's duration.
   * Tapping Profil during the walk-in then ran: clearHolds (holds -> 0, from showScreen),
   * the talk's own hold (-> 1), and finally the walk-in's stray timer (-> 0). The talk was
   * left unprotected and the kiosk bounced to the main menu three minutes later, in the
   * middle of a seven-minute profile. A release must never be able to decrement a hold it
   * did not take.
   */
  hold() {
    this.holds += 1;
    clearTimeout(this.timer);
    this.timer = null;
    const gen = this.generation;
    let spent = false;
    return () => {
      if (spent || gen !== this.generation) return;
      spent = true;
      this.holds = Math.max(0, this.holds - 1);
      if (this.holds === 0) this.reset();
    };
  }

  /** Force the hold count back to zero — used on every screen change. */
  clearHolds() {
    this.generation += 1;        // invalidates every release still outstanding
    this.holds = 0;
    this.reset();
  }

  dispose() {
    this.stop();
    for (const ev of ['pointerdown', 'touchstart', 'keydown', 'wheel']) {
      window.removeEventListener(ev, this._bump, { capture: true });
    }
  }
}
