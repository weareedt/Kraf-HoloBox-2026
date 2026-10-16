/**
 * Minimal SubRip parser + overlay renderer.
 *
 * Native <track> is deliberately not used: it would force a WebVTT conversion step,
 * and ::cue cannot produce the full-width translucent band this design uses.
 *
 * The real files have three traits this must survive (all verified against the
 * museum's masters, not assumed):
 *   - UTF-8 BOM at the start of the file
 *   - CRLF line endings
 *   - inline <i>...</i> markup, and nothing else
 * Everything except <i>/</i> is escaped, so subtitle text can never inject markup.
 */

const TIME = /(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/;

const toSeconds = (m) => +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / 1000;

const escapeHtml = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Escape everything, then re-allow only <i>. */
function safeMarkup(text) {
  return escapeHtml(text)
    .replace(/&lt;i&gt;/gi, '<i>')
    .replace(/&lt;\/i&gt;/gi, '</i>');
}

/** @returns {{start:number,end:number,html:string}[]} sorted by start time */
export function parseSrt(raw) {
  let text = raw;
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);   // strip BOM
  text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');   // normalise CRLF

  const cues = [];
  for (const block of text.split(/\n{2,}/)) {
    const lines = block.split('\n').filter((l) => l.trim() !== '');
    if (lines.length < 2) continue;

    // an optional numeric index line, then the timing line
    let i = 0;
    if (/^\d+$/.test(lines[0].trim())) i = 1;
    const timing = lines[i];
    if (!timing || !timing.includes('-->')) continue;

    const [a, b] = timing.split('-->');
    const ma = TIME.exec(a ?? '');
    const mb = TIME.exec(b ?? '');
    if (!ma || !mb) continue;

    const body = lines.slice(i + 1).join('\n');
    if (!body.trim()) continue;

    cues.push({
      start: toSeconds(ma),
      end: toSeconds(mb),
      html: safeMarkup(body).replace(/\n/g, '<br>'),
    });
  }
  return cues.sort((x, y) => x.start - y.start);
}

export async function loadSrt(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`subtitle ${res.status}: ${url}`);
  return parseSrt(await res.text());
}

/**
 * Drives a subtitle band element from a cue list.
 * Cheap: cues are sorted, so lookup walks from the last index rather than scanning.
 */
export class SubtitleBand {
  constructor(el) {
    this.el = el;
    this.cues = [];
    this.index = -1;
    this.hide();
  }

  setCues(cues) {
    this.cues = cues ?? [];
    this.index = -1;
    this.hide();
  }

  hide() {
    this.el.hidden = true;
    this.el.innerHTML = '';
  }

  /** Call from the video's timeupdate. */
  update(time) {
    if (!this.cues.length) return;

    // fast path: still inside the current cue
    const cur = this.cues[this.index];
    if (cur && time >= cur.start && time < cur.end) return;

    // walk forward from the current position; only rescan on a backward seek
    let i = this.index >= 0 && cur && time >= cur.end ? this.index + 1 : 0;
    if (i === 0) this.index = -1;
    for (; i < this.cues.length; i++) {
      const c = this.cues[i];
      if (time < c.start) break;
      if (time < c.end) {
        if (this.index !== i) {
          this.index = i;
          this.el.innerHTML = c.html;
          this.el.hidden = false;
        }
        return;
      }
    }
    if (this.index !== -1 || !this.el.hidden) {
      this.index = -1;
      this.hide();
    }
  }
}
