/* The face of the AI: a dotted thought-orb drawn on a plain 2D canvas, with a state for
   each thing the app can honestly say it is doing - listening, searching, composing.

   The drawing engine is thinking-orbs, third-party code kept as published with its MIT
   licence in src/vendor/thinking-orbs.js and loaded just before this file. This file is
   Aura's own: the <thinking-orb> element, which reaches the engine through V,
   window.Aura.orbs. */
window.Orbs = (function () {
  const V = window.Aura.orbs;

  // ---- The element ----
  //
  // Written after upstream's ThinkingOrb.tsx: the same shared clock, the same single still
  // frame when motion is unwanted, the same rest while out of sight. It is a custom element
  // rather than a function to call because every screen here is painted as a string:
  // markup that names an orb gets a running one, and markup that is painted over takes its
  // orb down with it, with nothing for the view to remember.
  //
  //   <thinking-orb state="searching"></thinking-orb>
  //
  //   state   one of the nine, "working" when left out or unknown
  //   size    the tuned preset, 64 or 20 - two designs, not one design scaled
  //   px      the drawn size in CSS pixels, when it is not the preset's own
  //   theme   "dark" is light ink for the app's dark surfaces and the default, since the
  //           app has no light theme; "light" is dark ink, for an accent-coloured surface
  //   speed   a multiplier on the preset's own speed
  //   paused  holds the frame it is on

  const LABELS = {
    working: "Working…",
    searching: "Searching…",
    solving: "Solving…",
    listening: "Listening…",
    connecting: "Connecting…",
    weaving: "Weaving…",
    composing: "Composing…",
    breathing: "Thinking…",
    shaping: "Shaping…"
  };

  // Upstream's instant for the still frame: one that shows each state at its clearest.
  const STILL_AT = 0.6;
  const FADE_MS = 240;
  // A repaint swaps the orb for a new element within the same task. Anything slower than
  // this is a different orb arriving, not the same one changing its mind.
  const HANDOVER_MS = 80;
  const COVER_CHECK_MS = 500;

  const moving = new Set();
  let raf = 0, timer = 0, checkedAt = 0, quiet = false, seen = null;
  // The orb on the page under each id, kept for a moment after it leaves, so the one that
  // takes its place can fade from what was on screen. `left` is when it left, 0 while here.
  const faces = new Map();

  // The full player, a sheet or a dialog lies over the screen without hiding it, and an
  // orb underneath would go on drawing sixty frames a second for nobody. Whatever is
  // topmost at its centre says whether it can be seen.
  function covered(orb) {
    const box = orb.getBoundingClientRect();
    const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return !!top && top !== orb && !orb.contains(top) && !top.contains(orb);
  }

  function tick(now) {
    raf = 0;
    if (now - checkedAt >= COVER_CHECK_MS) {
      checkedAt = now;
      moving.forEach(orb => { orb._covered = covered(orb); });
    }
    let drew = false;
    moving.forEach(orb => {
      if (orb._covered) return;
      orb.draw(now);
      drew = true;
    });
    if (!moving.size) return;
    // With every orb covered there is nothing to draw, only a reason to look again.
    if (drew) raf = requestAnimationFrame(tick);
    else timer = setTimeout(() => { timer = 0; wake(); }, COVER_CHECK_MS);
  }

  function wake() {
    if (!raf && !timer && moving.size && !document.hidden) raf = requestAnimationFrame(tick);
  }

  function rest() {
    cancelAnimationFrame(raf);
    clearTimeout(timer);
    raf = 0; timer = 0;
  }

  function define() {
    class ThinkingOrb extends HTMLElement {
      static get observedAttributes() { return ["state", "size", "px", "theme", "speed", "paused"]; }

      connectedCallback() {
        if (!this._canvas) {
          this._canvas = document.createElement("canvas");
          this._canvas.style.display = "block";
          this.appendChild(this._canvas);
        }
        this._onscreen = true;
        this._covered = false;
        this.setup();
        // The orb this one replaces was on screen a moment ago: fade from it, not from nothing.
        // innerHTML brings the new element in before it tells the old one it has left, so an
        // orb that is off the page with no leaving time was replaced in this very task.
        const last = this.id ? faces.get(this.id) : null;
        if (last && last.orb !== this && !last.orb.isConnected &&
          (!last.left || performance.now() - last.left < HANDOVER_MS)) this.fadeFrom(last.orb._look);
        if (this.id) faces.set(this.id, { orb: this, left: 0 });
        if (seen) seen.observe(this);
        this.sync();
      }

      disconnectedCallback() {
        moving.delete(this);
        if (seen) seen.unobserve(this);
        const now = performance.now();
        faces.forEach((face, id) => { if (face.left && now - face.left >= HANDOVER_MS) faces.delete(id); });
        const face = faces.get(this.id);
        if (face && face.orb === this) face.left = now;
      }

      attributeChangedCallback(name, was, now) {
        if (was === now || !this.isConnected || !this._canvas) return;
        const before = this._look;
        this.setup();
        if (name === "state") this.fadeFrom(before);
        this.sync();
      }

      fadeFrom(look) {
        if (quiet || !look || look.state === this._look.state) return;
        this._from = look;
        this._fadeAt = performance.now();
      }

      setup() {
        const asked = this.getAttribute("state");
        const state = Object.prototype.hasOwnProperty.call(V.STATE_TO_MODE, asked) ? asked : "working";
        const size = this.getAttribute("size") === "20" ? 20 : 64;
        const px = Math.min(320, Math.max(12, parseFloat(this.getAttribute("px")) || size));
        const speed = parseFloat(this.getAttribute("speed"));
        const preset = V.resolvePreset(state, size);
        this._look = {
          state, px, opts: preset.opts, frame: V.MODE_FRAMES[preset.mode],
          speed: preset.speed * (speed > 0 ? speed : 1),
          dark: this.getAttribute("theme") !== "light"
        };
        // Sharp on a phone, and no sharper than anyone can see: upstream's cap.
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        const edge = Math.round(px * dpr);
        // Assigning a canvas its size wipes it, so only when the size really changed. Both
        // sides are checked: a new canvas is 300 by 150, and an orb that needs 300 across
        // would otherwise keep the 150 and draw its top half stretched over the square.
        if (this._canvas.width !== edge || this._canvas.height !== edge) { this._canvas.width = edge; this._canvas.height = edge; }
        this._dpr = dpr;
        if (!this.style.display) this.style.display = "inline-block";
        this.style.width = this.style.height = this._canvas.style.width = this._canvas.style.height = px + "px";
        // Inside a button the button's own label speaks, and the markup says aria-hidden.
        if (this.getAttribute("aria-hidden") === "true") return;
        if (!this.hasAttribute("role")) this.setAttribute("role", "img");
        if (this._labelled || !this.hasAttribute("aria-label")) {
          this._labelled = true;
          this.setAttribute("aria-label", LABELS[state]);
        }
      }

      sync() {
        if (this.isConnected && this._onscreen && !quiet && !this.hasAttribute("paused")) {
          moving.add(this);
          wake();
        } else moving.delete(this);
        // One frame right away either way: a paused, still or unseen orb is never blank.
        this.draw(performance.now());
      }

      draw(now) {
        const ctx = this._ctx || (this._ctx = this._canvas.getContext("2d"));
        if (!ctx) return;
        const look = this._look;
        // One clock for every orb, so a row of them stays in phase and a new element picks
        // up exactly where the one it replaced left off.
        const at = l => quiet ? STILL_AT : now / 1000 * l.speed;
        let k = 1;
        if (this._from) {
          k = quiet ? 1 : Math.min(1, (now - this._fadeAt) / FADE_MS);
          if (k >= 1) this._from = null;
        }
        ctx.setTransform(this._dpr, 0, 0, this._dpr, 0, 0);
        ctx.clearRect(0, 0, look.px, look.px);
        if (this._from) {
          ctx.globalAlpha = 1 - k;
          V.paintFrame(ctx, this._from.frame(look.px, at(this._from), this._from.opts), this._from.dark);
        }
        ctx.globalAlpha = k;
        V.paintFrame(ctx, look.frame(look.px, at(look), look.opts), look.dark);
        ctx.globalAlpha = 1;
      }
    }

    if (typeof IntersectionObserver !== "undefined") {
      seen = new IntersectionObserver(entries => entries.forEach(entry => {
        const orb = /** @type {ThinkingOrb} */ (entry.target);
        orb._onscreen = entry.isIntersecting;
        if (orb.isConnected) orb.sync();
      }));
    }

    // Motion is unwanted when the system says so or when Settings turned animations off,
    // and either can change while an orb is on screen.
    const motion = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
    const root = document.documentElement;
    const settle = () => {
      const now = !!(motion && motion.matches) || root.classList.contains("no-anim");
      if (now === quiet) return;
      quiet = now;
      /** @type {NodeListOf<ThinkingOrb>} */ (document.querySelectorAll("thinking-orb")).forEach(orb => { if (orb.sync) orb.sync(); });
    };
    settle();
    if (motion && motion.addEventListener) motion.addEventListener("change", settle);
    if (typeof MutationObserver !== "undefined") new MutationObserver(settle).observe(root, { attributes: true, attributeFilter: ["class"] });
    document.addEventListener("visibilitychange", () => { if (document.hidden) rest(); else wake(); });

    customElements.define("thinking-orb", ThinkingOrb);
  }

  if (typeof HTMLElement !== "undefined" && window.customElements && !customElements.get("thinking-orb")) define();

  return { engine: { resolvePreset: V.resolvePreset, MODE_FRAMES: V.MODE_FRAMES, STATE_TO_MODE: V.STATE_TO_MODE } };
})();
