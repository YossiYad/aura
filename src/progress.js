/* The wavy song timeline shared by the mini bar, the full player, driving mode and the TV.
   It is drawn in real pixels rather than a stretched viewBox: a stretched wave changes its
   length with the width of whatever holds it, so the same song looked different on a
   phone, in landscape and across a television. */
window.SongProgress = (function () {
  const SVG = "http://www.w3.org/2000/svg";
  // Everything follows the drawn height: a 20px timeline carries 40px waves, 4px tall.
  const HALF_WAVE = 1, AMPLITUDE = 0.2, DOT = 0.15, THUMB = 0.3;
  // A seek the backend has not caught up with yet still reports the old position. The
  // released position stays on screen until the clock agrees with it, or this long.
  const SEEK_HOLD_MS = 800;
  // "wave" or "line": the same timeline with its waves pressed flat. One choice for every
  // timeline on the page, the ones made before it changes and the ones made after.
  let style = "wave";
  const timelines = [];

  const round = n => Math.round(n * 100) / 100;

  // The played part only, so its moving end keeps a round cap. Each half wave is one
  // quadratic whose control point sits over its middle, which makes x linear in t: the
  // last one is cut at the exact playback position (de Casteljau) instead of clipped.
  /**
   * Builds the SVG path of the played part of the timeline.
   * @param {number} from Start x, in pixels.
   * @param {number} to End x, in pixels.
   * @param {number} mid Centre line y.
   * @param {number} half Length of half a wave.
   * @param {number} amp Wave height; 0 draws a straight line.
   * @returns {{ d: string, x: number, y: number }} The path and the point where it ends.
   */
  function wave(from, to, mid, half, amp) {
    let d = "", x = from, y = mid;
    if (to > from && !amp) {
      d = "M" + round(from) + " " + round(mid) + " L" + round(to) + " " + round(mid);
      x = to;
    } else if (to > from && half > 0) {
      d = "M" + round(from) + " " + round(mid);
      for (let start = from, n = 0; start < to - 0.005; start += half, n++) {
        const t = Math.min(1, (to - start) / half);
        const bend = (n % 2 ? 2 : -2) * amp;
        x = start + half * t;
        y = mid + 2 * bend * t * (1 - t);
        d += " Q" + round(start + half / 2 * t) + " " + round(mid + bend * t) + " " + round(x) + " " + round(y);
      }
    }
    return { d, x, y };
  }

  /**
   * Draws a timeline into an element.
   * @param {HTMLElement} root
   * @param {{ onSeek?: (pct: number) => void, onPreview?: (pct: number | null) => void,
   *   keyStep?: () => number, touch?: boolean }} [options] Without onSeek it only shows progress.
   * `keyStep` is the arrow-key step in percent; `touch: false` ignores touch input.
   * @returns {{ set: (pct: number) => void, scrubbing: () => boolean }} `set` takes 0-100.
   */
  function create(root, options) {
    const opts = options || {};
    const seekable = typeof opts.onSeek === "function";
    const svg = document.createElementNS(SVG, "svg");
    svg.setAttribute("aria-hidden", "true");
    const part = (tag, name) => {
      const el = document.createElementNS(SVG, tag);
      el.setAttribute("class", "song-progress-" + name);
      svg.appendChild(el);
      return el;
    };
    const track = part("line", "track"), fill = part("path", "wave");
    const dot = part("circle", "end"), thumb = part("circle", "thumb");
    root.classList.add("song-progress");
    root.prepend(svg);

    let width = 0, height = 0, value = 0, shown = -1, scrubbing = false;
    let held = null, heldAt = 0, ariaNow = -1;

    function paint(pct) {
      shown = pct;
      if (!width || !height) return;
      const inset = height * DOT, mid = height / 2;
      const to = inset + (width - inset * 2) * pct / 100;
      const end = wave(inset, to, mid, height * HALF_WAVE, style === "line" ? 0 : height * AMPLITUDE);
      fill.setAttribute("d", end.d);
      track.setAttribute("x1", String(round(to)));
      thumb.setAttribute("cx", String(round(end.x)));
      thumb.setAttribute("cy", String(round(end.y)));
      if (seekable) {
        const now = Math.round(pct);
        if (now !== ariaNow) { ariaNow = now; root.setAttribute("aria-valuenow", String(now)); }
      }
    }

    function layout(w, h) {
      if (w === width && h === height) return;
      width = w;
      height = h;
      if (!w || !h) return;
      const inset = h * DOT, mid = String(round(h / 2)), right = String(round(w - inset));
      track.setAttribute("y1", mid);
      track.setAttribute("y2", mid);
      track.setAttribute("x2", right);
      dot.setAttribute("cx", right);
      dot.setAttribute("cy", mid);
      dot.setAttribute("r", String(round(inset)));
      thumb.setAttribute("r", String(round(h * THUMB)));
      paint(shown < 0 ? value : shown);
    }

    function measure() {
      const box = svg.getBoundingClientRect();
      layout(box.width, box.height);
    }

    // A closed player is display:none and measures nothing; the observer reports its real
    // size when it opens, before that frame is painted. set() still measures for itself
    // while it has no size, because a page that is not being rendered is not observed.
    if (window.ResizeObserver) {
      new ResizeObserver(entries => {
        const box = entries[entries.length - 1].contentRect;
        layout(box.width, box.height);
      }).observe(svg);
    } else {
      window.addEventListener("resize", measure);
    }

    function set(pct) {
      value = Math.max(0, Math.min(100, Number(pct) || 0));
      if (scrubbing) return;
      if (held !== null) {
        if (Math.abs(value - held) > 1.5 && Date.now() - heldAt < SEEK_HOLD_MS) return;
        held = null;
      }
      if (!width) measure();
      if (value !== shown) paint(value);
    }

    if (seekable) {
      const at = event => {
        const box = svg.getBoundingClientRect();
        const inset = box.height * DOT, span = box.width - inset * 2;
        return span > 0 ? Math.max(0, Math.min(100, (event.clientX - box.left - inset) / span * 100)) : 0;
      };
      const preview = pct => {
        paint(pct);
        if (opts.onPreview) opts.onPreview(pct);
      };
      const release = () => {
        scrubbing = false;
        root.classList.remove("scrubbing");
      };
      const commit = pct => {
        held = pct;
        heldAt = Date.now();
        paint(pct);
        opts.onSeek(pct);
      };
      root.classList.add("seekable");
      if (opts.touch !== false) root.classList.add("touch");
      root.addEventListener("pointerdown", event => {
        if (event.button || root.getAttribute("aria-disabled") === "true") return;
        if (event.pointerType === "touch" && opts.touch === false) return;
        scrubbing = true;
        root.classList.add("scrubbing");
        try { root.setPointerCapture(event.pointerId); } catch (e) {}
        preview(at(event));
      });
      root.addEventListener("pointermove", event => { if (scrubbing) preview(at(event)); });
      root.addEventListener("pointerup", event => {
        if (!scrubbing) return;
        release();
        commit(at(event));
      });
      // A touch the system took back (a notification, a palm) is not a decision to seek.
      root.addEventListener("pointercancel", () => {
        if (!scrubbing) return;
        release();
        paint(value);
        if (opts.onPreview) opts.onPreview(null);
      });
      root.addEventListener("keydown", event => {
        // Shift with an arrow is next and previous, everywhere in the app.
        if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return;
        if (root.getAttribute("aria-disabled") === "true") return;
        const step = opts.keyStep ? opts.keyStep() : 1;
        const from = held !== null ? held : value;
        let to;
        if (event.key === "ArrowLeft" || event.key === "ArrowDown") to = from - step;
        else if (event.key === "ArrowRight" || event.key === "ArrowUp") to = from + step;
        else if (event.key === "Home") to = 0;
        else if (event.key === "End") to = 100;
        else return;
        event.preventDefault();
        commit(Math.max(0, Math.min(100, to)));
      });
    }

    const restyle = () => {
      root.classList.toggle("line", style === "line");
      paint(shown < 0 ? value : shown);
    };
    timelines.push(restyle);
    restyle();
    return { set, scrubbing: () => scrubbing };
  }

  /**
   * @param {"wave" | "line"} name Applies to every timeline on the page.
   */
  function setStyle(name) {
    const next = name === "line" ? "line" : "wave";
    if (next === style) return;
    style = next;
    timelines.forEach(restyle => restyle());
  }

  return { create, setStyle, wave };
})();
