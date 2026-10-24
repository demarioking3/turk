/*
 * TURK music — lobby + card-table background music with a black-and-gold control.
 *
 * One music engine per page (calling init() twice returns the same one), one audio
 * element per track, so tracks never double up. Uses the Web Audio API for volume
 * and crossfades (needed for iPhone/iPad, where audio.volume is ignored), and falls
 * back to plain audio.volume where Web Audio isn't available.
 *
 * Hook it into the game with four calls:
 *   TurkMusic.init()                 once, when the game UI loads
 *   TurkMusic.setScene("lobby")      when the player is in the lobby / waiting room
 *   TurkMusic.setScene("table")      when a round starts
 *   TurkMusic.destroy()              when the player leaves the game (optional — also runs on page unload)
 *
 * Missing or broken audio files never throw: the control just shows "Music unavailable".
 */

const DEFAULTS = {
  lobbySrc: "/audio/turk-lobby.mp3",   // served from public/audio/turk-lobby.mp3
  tableSrc: "/audio/turk-table.mp3",   // served from public/audio/turk-table.mp3
  mount: null,                         // element to put the control in; default: fixed corner of the page
  volume: 0.6,                         // starting volume 0–1 (until the player changes it)
  fadeMs: 1200,                        // crossfade length between lobby and table
  storageKey: "turk-music",            // sessionStorage key for the player's preference
};

const SCENES = ["lobby", "table", "off"];
let instance = null;

/* ---------- small safe helpers ---------- */
function readPrefs(key) {
  try { return JSON.parse(sessionStorage.getItem(key) || "null") || {}; } catch (e) { return {}; }
}
function writePrefs(key, prefs) {
  try { sessionStorage.setItem(key, JSON.stringify(prefs)); } catch (e) { /* private mode etc. — ignore */ }
}
function clamp01(n) { n = Number(n); return isFinite(n) ? Math.min(1, Math.max(0, n)) : 0; }

const ICONS = {
  note: "M9 18V5l12-2v13M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zm12-2a3 3 0 1 1-6 0 3 3 0 0 1 6 0z",
  play: "M7 4l13 8-13 8z",
  pause: "M7 4h4v16H7zM14 4h4v16h-4z",
  vol: "M4 9h4l5-4v14l-5-4H4zM16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12",
  mute: "M4 9h4l5-4v14l-5-4H4zM17 9l5 6M22 9l-5 6",
};
function icon(name) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const p = document.createElementNS(ns, "path");
  p.setAttribute("d", ICONS[name]);
  svg.appendChild(p);
  return svg;
}
function setIcon(btn, name) { btn.replaceChild(icon(name), btn.firstChild); }
function button(cls, label, iconName) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = cls;
  b.setAttribute("aria-label", label);
  b.title = label;
  b.appendChild(icon(iconName));
  return b;
}

/* ---------- the engine ---------- */
class MusicEngine {
  constructor(opts) {
    this.o = Object.assign({}, DEFAULTS, opts || {});
    const saved = readPrefs(this.o.storageKey);
    this.prefs = {
      enabled: saved.enabled === true,            // player has switched music on this session
      paused: saved.paused === true,
      muted: saved.muted === true,
      volume: saved.volume != null ? clamp01(saved.volume) : clamp01(this.o.volume),
    };
    this.scene = "off";
    this.unlocked = false;   // a click/tap has happened, so the browser allows sound
    this.ctx = null;
    this.master = null;
    this.tracks = {};
    this.fadeTimers = {};
    this.destroyed = false;

    this._makeTrack("lobby", this.o.lobbySrc);
    this._makeTrack("table", this.o.tableSrc);
    this._buildUI();
    this._render();

    // If they turned music on earlier this session, resume on their next tap/click/key.
    this._onFirstGesture = () => { if (this.prefs.enabled && !this.unlocked) this._unlock(); };
    if (this.prefs.enabled) {
      document.addEventListener("pointerdown", this._onFirstGesture, true);
      document.addEventListener("keydown", this._onFirstGesture, true);
    }
    this._onVisibility = () => this._handleVisibility();
    this._onPageHide = () => this.destroy();
    document.addEventListener("visibilitychange", this._onVisibility);
    window.addEventListener("pagehide", this._onPageHide);
  }

  _makeTrack(name, src) {
    const el = new Audio();
    el.loop = true;
    el.preload = "none";       // don't download until music is switched on
    el.crossOrigin = "anonymous";
    el.setAttribute("playsinline", "");
    const t = { name, src, el, gain: null, ok: !!src, level: 0, wantPlaying: false };
    el.addEventListener("error", () => { t.ok = false; t.wantPlaying = false; this._render(); });
    this.tracks[name] = t;
  }

  /* Browser autoplay rules: sound may only start inside a user gesture. */
  _unlock() {
    if (this.unlocked || this.destroyed) return;
    this.unlocked = true;
    document.removeEventListener("pointerdown", this._onFirstGesture, true);
    document.removeEventListener("keydown", this._onFirstGesture, true);
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) {
      try {
        this.ctx = new AC();
        this.master = this.ctx.createGain();
        this.master.connect(this.ctx.destination);
        Object.values(this.tracks).forEach((t) => {
          const srcNode = this.ctx.createMediaElementSource(t.el);
          t.gain = this.ctx.createGain();
          t.gain.gain.value = 0;
          srcNode.connect(t.gain).connect(this.master);
        });
      } catch (e) { this.ctx = null; this.master = null; Object.values(this.tracks).forEach((t) => { t.gain = null; }); }
    }
    Object.values(this.tracks).forEach((t) => { if (t.ok) { t.el.src = t.src; t.el.preload = "auto"; } });
    this._applyMaster();
    this._sync(true);
  }

  _applyMaster() {
    const v = this.prefs.muted ? 0 : this.prefs.volume;
    if (this.master) {
      this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.03);
    } else {
      Object.values(this.tracks).forEach((t) => { t.el.volume = clamp01(t.level * v); });
    }
  }

  /* Fade one track's own level to 0 or 1 over ms, then pause it if it reached 0. */
  _fade(t, to, ms) {
    clearTimeout(this.fadeTimers[t.name]);
    t.level = to;
    const sec = Math.max(0.01, ms / 1000);
    if (t.gain) {
      const g = t.gain.gain, now = this.ctx.currentTime;
      g.cancelScheduledValues(now);
      g.setValueAtTime(g.value, now);
      g.linearRampToValueAtTime(to, now + sec);
    } else {
      // Fallback without Web Audio: step audio.volume (desktop browsers only honour this).
      const start = t.el.volume, master = this.prefs.muted ? 0 : this.prefs.volume, t0 = performance.now();
      const step = () => {
        const k = Math.min(1, (performance.now() - t0) / ms);
        t.el.volume = clamp01((start + (to * master - start) * k));
        if (k < 1 && t.level === to) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    }
    if (to === 0) {
      this.fadeTimers[t.name] = setTimeout(() => { if (t.level === 0) t.el.pause(); }, ms + 50);
    }
  }

  /* Make what's audible match: scene + enabled + paused. Only ever one track rising. */
  _sync(fromGesture) {
    if (this.destroyed) return;
    const audible = this.prefs.enabled && !this.prefs.paused && this.unlocked && this.scene !== "off";
    const ms = fromGesture ? 400 : this.o.fadeMs;
    Object.values(this.tracks).forEach((t) => {
      const on = audible && t.name === this.scene && t.ok;
      if (on) {
        if (this.ctx && this.ctx.state === "suspended") this.ctx.resume().catch(() => {});
        if (t.el.paused) {
          const p = t.el.play();
          if (p && p.catch) p.catch(() => { /* blocked or missing — leave it silent */ this._render(); });
        }
        this._fade(t, 1, ms);
      } else if (t.level !== 0 || !t.el.paused) {
        this._fade(t, 0, ms);
      }
    });
    this._render();
  }

  _handleVisibility() {
    if (!this.ctx) return;
    if (document.hidden) this.ctx.suspend().catch(() => {});
    else if (this.prefs.enabled && !this.prefs.paused) this.ctx.resume().catch(() => {});
  }

  _save() { writePrefs(this.o.storageKey, this.prefs); }

  /* ---------- public API ---------- */
  setScene(scene) {
    if (SCENES.indexOf(scene) === -1) return;
    if (scene === this.scene) return;
    this.scene = scene;
    this._sync(false);
  }
  enable() { this.prefs.enabled = true; this.prefs.paused = false; this._save(); this._unlock(); this._sync(true); }
  play() { if (!this.prefs.enabled) return this.enable(); this.prefs.paused = false; this._save(); this._unlock(); this._sync(true); }
  pause() { this.prefs.paused = true; this._save(); this._sync(true); }
  togglePlay() { (this.prefs.enabled && !this.prefs.paused) ? this.pause() : this.play(); }
  setMuted(m) { this.prefs.muted = !!m; this._save(); this._applyMaster(); this._render(); }
  toggleMute() { this.setMuted(!this.prefs.muted); }
  setVolume(v) {
    this.prefs.volume = clamp01(v);
    if (this.prefs.volume > 0 && this.prefs.muted) this.prefs.muted = false;
    this._save(); this._applyMaster(); this._render();
  }
  getState() {
    return {
      scene: this.scene, enabled: this.prefs.enabled, paused: this.prefs.paused,
      muted: this.prefs.muted, volume: this.prefs.volume, unlocked: this.unlocked,
      available: { lobby: this.tracks.lobby.ok, table: this.tracks.table.ok },
      playing: Object.values(this.tracks).filter((t) => !t.el.paused).map((t) => t.name),
    };
  }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    Object.values(this.fadeTimers).forEach(clearTimeout);
    Object.values(this.tracks).forEach((t) => { try { t.el.pause(); t.el.removeAttribute("src"); t.el.load(); } catch (e) {} });
    if (this.ctx) this.ctx.close().catch(() => {});
    document.removeEventListener("pointerdown", this._onFirstGesture, true);
    document.removeEventListener("keydown", this._onFirstGesture, true);
    document.removeEventListener("visibilitychange", this._onVisibility);
    window.removeEventListener("pagehide", this._onPageHide);
    if (this.root && this.root.parentNode) this.root.parentNode.removeChild(this.root);
    if (instance === this) instance = null;
  }

  /* ---------- the control ---------- */
  _buildUI() {
    const root = document.createElement("div");
    root.className = "turk-music" + (this.o.mount ? " turk-music--inline" : "");
    root.setAttribute("role", "group");
    root.setAttribute("aria-label", "Music");

    const enableBtn = document.createElement("button");
    enableBtn.type = "button";
    enableBtn.className = "turk-music__enable";
    enableBtn.appendChild(icon("note"));
    enableBtn.appendChild(document.createTextNode("Enable Music"));
    enableBtn.addEventListener("click", () => this.enable());

    const playBtn = button("turk-music__btn turk-music__btn--play", "Pause music", "pause");
    playBtn.addEventListener("click", () => this.togglePlay());
    const muteBtn = button("turk-music__btn", "Mute music", "vol");
    muteBtn.addEventListener("click", () => this.toggleMute());

    const slider = document.createElement("input");
    slider.type = "range";
    slider.min = "0"; slider.max = "100"; slider.step = "1";
    slider.className = "turk-music__volume";
    slider.setAttribute("aria-label", "Music volume");
    slider.addEventListener("input", () => this.setVolume(Number(slider.value) / 100));

    const status = document.createElement("span");
    status.className = "turk-music__status";
    status.setAttribute("aria-live", "polite");

    const controls = document.createElement("div");
    controls.className = "turk-music__controls";
    controls.append(playBtn, muteBtn, slider);

    root.append(enableBtn, controls, status);
    (this.o.mount || document.body).appendChild(root);
    Object.assign(this, { root, enableBtn, playBtn, muteBtn, slider, status, controls });
  }

  _render() {
    if (!this.root) return;
    const s = this.prefs;
    const track = this.scene !== "off" ? this.tracks[this.scene] : null;
    const missing = !this.tracks.lobby.ok && !this.tracks.table.ok;
    const sceneMissing = track && !track.ok;
    const waitingForTap = s.enabled && !this.unlocked;

    this.enableBtn.hidden = s.enabled || missing;
    this.controls.hidden = !s.enabled || missing;
    this.root.classList.toggle("is-unavailable", missing);

    const playing = s.enabled && !s.paused;
    setIcon(this.playBtn, playing ? "pause" : "play");
    this.playBtn.setAttribute("aria-label", playing ? "Pause music" : "Play music");
    this.playBtn.title = this.playBtn.getAttribute("aria-label");
    this.playBtn.setAttribute("aria-pressed", String(playing));

    const silent = s.muted || s.volume === 0;
    setIcon(this.muteBtn, silent ? "mute" : "vol");
    this.muteBtn.setAttribute("aria-label", silent ? "Unmute music" : "Mute music");
    this.muteBtn.title = this.muteBtn.getAttribute("aria-label");
    this.muteBtn.setAttribute("aria-pressed", String(silent));

    const pct = Math.round((s.muted ? 0 : s.volume) * 100);
    this.slider.value = String(pct);
    this.slider.style.setProperty("--turk-fill", pct + "%");
    this.slider.setAttribute("aria-valuetext", pct + "%");

    let msg = "";
    if (missing) msg = "Music unavailable";
    else if (sceneMissing) msg = "No track for this screen";
    else if (waitingForTap) msg = "Tap anywhere to resume";
    this.status.textContent = msg;
    this.status.hidden = !msg;
  }
}

const TurkMusic = {
  /** Create (or return) the one music engine. Options: lobbySrc, tableSrc, mount, volume, fadeMs. */
  init(opts) { if (!instance) instance = new MusicEngine(opts); return instance; },
  setScene(scene) { if (instance) instance.setScene(scene); },
  destroy() { if (instance) instance.destroy(); },
  get() { return instance; },
};

if (typeof window !== "undefined") window.TurkMusic = TurkMusic;
export default TurkMusic;
