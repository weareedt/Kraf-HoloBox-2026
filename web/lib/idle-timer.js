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

  /** Suspend the countdown (a non-looping video started). */
  hold() {
    this.holds += 1;
    clearTimeout(this.timer);
    this.timer = null;
  }

  /** Resume the countdown (that video ended, paused or was abandoned). */
  release() {
    this.holds = Math.max(0, this.holds - 1);
    if (this.holds === 0) this.reset();
  }

  /** Force the hold count back to zero — used on every screen change. */
  clearHolds() {
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
