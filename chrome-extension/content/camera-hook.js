// ============================================================================
// Instant Transmission — Camera Hook (MAIN world)
//
// Runs in the page's JS context (world: "MAIN") so it can override
// navigator.mediaDevices.getUserMedia before the video call application loads.
//
// Features:
//   - MediaPipe gesture detection via iframe worker (two fingers on forehead)
//   - Alt+G keyboard charging & trigger
//   - Floating ⚡ button
//   - Canvas video processing pipeline
//   - Anime instant transmission effect (aura, ghost streak, flash, particles)
// ============================================================================
(function () {
  "use strict";

  // ======================================================================
  // STATE
  // ======================================================================
  const state = {
    enabled: true,
    visible: true,         // person currently shown
    effectActive: null,    // running TeleportEffect instance
    charging: false,       // holding the hotkey or gesture
    chargeFrac: 0,         // 0‥1
    chargeStart: null,     // performance.now() timestamp
    gestureReady: false,   // worker loaded and models ready
    workerUrl: null,       // URL for gesture-worker.html
  };

  const CONFIG = {
    HOLD_SECONDS: 0.60,
    EFFECT_DURATION: 0.70,
    HOTKEY: "KeyG",        // Alt+G
    BG_HOTKEY: "KeyB",     // Alt+B
    DETECT_INTERVAL_MS: 50, // run gesture detector at 20 FPS
  };

  // ======================================================================
  // PARTICLE
  // ======================================================================
  class Particle {
    constructor(x, y, vx, vy, life, size, color, brightness) {
      this.x = x;
      this.y = y;
      this.px = x;
      this.py = y;
      this.vx = vx;
      this.vy = vy;
      this.life = life;
      this.maxLife = life;
      this.size = size;
      this.color = color;
      this.bright = brightness;
    }
  }

  const PALETTE = [
    [255, 255, 255],
    [100, 200, 255],
    [50, 160, 200],
    [200, 230, 255],
    [255, 255, 200],
    [60, 180, 255],
  ];

  class ParticleSystem {
    constructor(w, h, vanishing) {
      this.particles = [];
      const N = 800;
      const cx = w / 2,
        cy = h * 0.42;
      const sw = w * 0.28,
        sh = h * 0.42;
      for (let i = 0; i < N; i++) {
        const a = Math.random() * Math.PI * 2;
        const r = Math.sqrt(Math.random());
        const sx = cx + Math.cos(a) * r * sw;
        const sy = cy + Math.sin(a) * r * sh;
        const speed = 60 + Math.random() * 280;
        const va = Math.random() * Math.PI * 2;
        const vx = Math.cos(va) * speed * 0.5;
        let vy;
        if (vanishing) {
          vy = -Math.abs(Math.sin(va) * speed) * 0.8 - 40;
        } else {
          vy = Math.abs(Math.sin(va) * speed) * 0.3;
        }
        const life = 0.3 + Math.random() * 0.5;
        const size = 1 + Math.floor(Math.random() * 4);
        const color = PALETTE[Math.floor(Math.random() * PALETTE.length)];
        this.particles.push(
          new Particle(sx, sy, vx, vy, life, size, color, 0.5 + Math.random() * 0.5)
        );
      }
    }
    step(dt) {
      this.particles = this.particles.filter((p) => {
        p.life -= dt;
        if (p.life <= 0) return false;
        p.px = p.x;
        p.py = p.y;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.vy += 50 * dt;
        return true;
      });
    }
    draw(ctx, alpha) {
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      for (const p of this.particles) {
        const frac = p.life / p.maxLife;
        const a = alpha * frac * p.bright;
        if (a < 0.05) continue;
        const [r, g, b] = p.color;
        // trail
        ctx.beginPath();
        ctx.strokeStyle = `rgba(${r},${g},${b},${a * 0.35})`;
        ctx.lineWidth = Math.max(1, p.size - 1);
        ctx.moveTo(p.px, p.py);
        ctx.lineTo(p.x, p.y);
        ctx.stroke();
        // head
        ctx.beginPath();
        ctx.fillStyle = `rgba(${r},${g},${b},${a})`;
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
  }

  // ======================================================================
  // TELEPORT EFFECT
  // ======================================================================
  class TeleportEffect {
    static STREAK_END = 0.17;
    static FLASH_START = 0.14;
    static FLASH_PEAK = 0.20;
    static FLASH_END = 0.28;
    static CUT = 0.18;
    static PARTICLE_START = 0.18;

    constructor(w, h, vanishing) {
      this.t0 = performance.now() / 1000;
      this.last = this.t0;
      this.vanishing = vanishing;
      this.w = w;
      this.h = h;
      this.dur = CONFIG.EFFECT_DURATION;
      this.particles = new ParticleSystem(w, h, vanishing);

      this.ghosts = Array.from({ length: 3 }, () => ({
        dx: Math.floor(Math.random() * 17) - 8,
        dy: -3 - Math.floor(Math.random() * 17),
      }));

      const px = w * 0.3,
        pw = w * 0.4,
        py = h * 0.1,
        ph = h * 0.8;
      this.lines = Array.from({ length: 30 }, (_, i) => ({
        x: px + (pw * i) / 30,
        y: py + ph * (-0.1 + Math.random() * 0.7),
        len: ph * (0.4 + Math.random() * 0.6),
        dark: i % 4 === 0,
      }));

      this.shakePx = 8;
    }

    render(ctx, liveCanvas, bgCanvas, now_s) {
      const t = (now_s - this.t0) / this.dur;
      const dt = now_s - this.last;
      this.last = now_s;
      if (t >= 1) return false;

      const { w, h } = this;
      const T = TeleportEffect;
      const beforeCut = t < T.CUT;
      const personShown = beforeCut === this.vanishing;

      let sx = 0,
        sy = 0;
      if (t > T.FLASH_START && t < T.FLASH_END) {
        const peak = Math.max(
          T.FLASH_PEAK - T.FLASH_START,
          T.FLASH_END - T.FLASH_PEAK
        );
        const sf = 1 - Math.abs(t - T.FLASH_PEAK) / peak;
        const inten = Math.max(0, sf) * this.shakePx;
        sx = (Math.random() - 0.5) * 2 * inten;
        sy = (Math.random() - 0.5) * 2 * inten;
      }

      ctx.save();
      ctx.translate(sx, sy);
      ctx.drawImage(personShown ? liveCanvas : bgCanvas, 0, 0);

      // afterimage streak
      if (t < T.STREAK_END) {
        const st = t / T.STREAK_END;
        for (let i = 0; i < this.ghosts.length; i++) {
          const { dx, dy } = this.ghosts[i];
          const alpha = (1 - st) * (0.4 - i * 0.1);
          if (alpha <= 0) continue;
          ctx.save();
          ctx.globalAlpha = alpha;
          ctx.filter =
            "saturate(0.5) brightness(0.8) sepia(0.3) hue-rotate(200deg)";
          ctx.drawImage(liveCanvas, dx * st * 3, dy * st * 3);
          ctx.restore();
        }
        const la = st * 0.7;
        const drift = st * 0.15 * h * (this.vanishing ? 1 : -1);
        ctx.save();
        for (const l of this.lines) {
          ctx.beginPath();
          ctx.strokeStyle = l.dark
            ? `rgba(40,42,50,${la})`
            : `rgba(245,248,255,${la})`;
          ctx.lineWidth = l.dark ? 2 : 1;
          ctx.moveTo(l.x, l.y + drift);
          ctx.lineTo(l.x, l.y + l.len + drift);
          ctx.stroke();
        }
        ctx.restore();
      }

      // white flash
      if (t >= T.FLASH_START && t <= T.FLASH_END) {
        let fi;
        if (t < T.FLASH_PEAK)
          fi = (t - T.FLASH_START) / (T.FLASH_PEAK - T.FLASH_START);
        else fi = 1 - (t - T.FLASH_PEAK) / (T.FLASH_END - T.FLASH_PEAK);
        fi = Math.pow(Math.max(0, fi), 0.6) * 0.85;
        const gd = ctx.createRadialGradient(w / 2, h * 0.4, 0, w / 2, h * 0.4, w * 0.5);
        gd.addColorStop(0, `rgba(255,255,255,${fi})`);
        gd.addColorStop(0.5, `rgba(200,220,255,${fi * 0.6})`);
        gd.addColorStop(1, `rgba(100,150,255,${fi * 0.1})`);
        ctx.fillStyle = gd;
        ctx.fillRect(0, 0, w, h);
      }

      // energy ring
      if (t >= T.FLASH_START && t <= T.FLASH_END + 0.1) {
        const ringT = (t - T.FLASH_START) / (T.FLASH_END + 0.1 - T.FLASH_START);
        const maxR = Math.max(w, h) * 0.6;
        const radius = ringT * maxR;
        const ringAlpha = Math.max(0, 1 - ringT) * 0.7;
        ctx.save();
        ctx.globalCompositeOperation = "lighter";
        ctx.beginPath();
        ctx.arc(w / 2, h * 0.4, radius, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(100,200,255,${ringAlpha})`;
        ctx.lineWidth = 4 + (1 - ringT) * 8;
        ctx.shadowColor = "rgba(100,200,255,0.8)";
        ctx.shadowBlur = 20;
        ctx.stroke();
        ctx.restore();
      }

      // particles
      if (t >= T.PARTICLE_START) {
        const pt = (t - T.PARTICLE_START) / (1 - T.PARTICLE_START);
        this.particles.step(dt);
        const pa = this.vanishing ? 1 - pt * 0.3 : pt;
        this.particles.draw(ctx, pa);
      }

      ctx.restore();
      return true;
    }
  }

  // ======================================================================
  // CHARGING AURA
  // ======================================================================
  function drawAura(ctx, w, h, charge) {
    if (charge <= 0) return;
    const pulse = 0.6 + 0.4 * Math.sin((performance.now() / 1000) * 12);
    const intensity = charge * pulse;
    const radius = 80 + charge * 60;
    const cx = w / 2,
      cy = h * 0.4;
    const bf = Math.max(0, 1 - charge * 1.5);
    const r = Math.floor(100 + 155 * (1 - bf));
    const g = Math.floor(200 + 55 * (1 - bf));

    ctx.save();
    ctx.globalCompositeOperation = "lighter";

    const gd = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
    gd.addColorStop(0, `rgba(${r},${g},255,${intensity * 0.5})`);
    gd.addColorStop(0.5, `rgba(${r},${g},255,${intensity * 0.25})`);
    gd.addColorStop(0.8, `rgba(100,180,255,${intensity * 0.08})`);
    gd.addColorStop(1, "rgba(100,180,255,0)");
    ctx.fillStyle = gd;
    ctx.fillRect(0, 0, w, h);

    if (charge > 0.3) {
      const n = Math.floor(charge * 20);
      for (let i = 0; i < n; i++) {
        const a =
          ((performance.now() / 200 + (i * Math.PI * 2) / n) %
            (Math.PI * 2));
        const sr = radius * (0.6 + Math.random() * 0.4);
        ctx.beginPath();
        ctx.fillStyle = `rgba(200,230,255,${
          intensity * (0.3 + Math.random() * 0.5)
        })`;
        ctx.arc(
          cx + Math.cos(a) * sr * 1.2,
          cy + Math.sin(a) * sr * 0.8,
          1 + Math.random() * 3,
          0,
          Math.PI * 2
        );
        ctx.fill();
      }
    }
    ctx.restore();
  }

  // ======================================================================
  // TELEPORT SOUND (from bundled MP3 asset)
  // ======================================================================
  let teleportAudio = null;

  function playTeleportSound() {
    try {
      if (!teleportAudio) {
        // Build the URL from the extension's assets folder.
        // In MAIN world we receive the base URL via IT_INIT_CONFIG;
        // derive the asset path from the worker URL.
        const base = state.workerUrl
          ? state.workerUrl.replace(/gesture\/gesture-worker\.html$/, "")
          : "";
        teleportAudio = new Audio(base + "assets/teleport.mp3");
        teleportAudio.volume = 0.6;
      }
      // Restart from the beginning if already playing
      teleportAudio.currentTime = 0;
      teleportAudio.play().catch(() => {});
    } catch (_) {}
  }

  // ======================================================================
  // GESTURE WORKER CLIENT (Iframe Manager)
  // ======================================================================
  class GestureClient {
    constructor() {
      this.iframe = null;
      this.ready = false;
      this.busy = false;
      this.lastSent = 0;
      this.requestId = 0;
      this.busySince = 0;
    }

    init(workerUrl) {
      if (this.iframe || !workerUrl) return;

      this.iframe = document.createElement("iframe");
      this.iframe.src = workerUrl;
      this.iframe.style.display = "none";
      this.iframe.id = "it-gesture-worker-frame";

      window.addEventListener("message", (e) => {
        if (e.source !== this.iframe?.contentWindow) return;
        if (e.data?.type === "GESTURE_READY") {
          this.ready = true;
          state.gestureReady = true;
          console.log("[IT] 🤞 Gesture detection active — hold two fingers to forehead!");
          const b = document.getElementById("it-btn");
          if (b) b.title = "Instant Transmission — Hold 2 fingers to forehead, Alt+G, or click";
        } else if (e.data?.type === "POSE_RESULT") {
          if (e.data.requestId !== this.requestId) return;
          this.busy = false;
          // Worker reports pose detection state & hold progress
          if (!state.effectActive) {
            state.chargeFrac = e.data.chargeFrac;
            if (e.data.trigger && processor) {
              processor._trigger();
            }
          }
        }
      });

      document.documentElement.appendChild(this.iframe);
      // Retry the config handshake in case bridge.js ran first.
      window.postMessage({ type: "IT_REQUEST_CONFIG" }, "*");
    }

    sendFrame(canvas, w, h) {
      if (!this.ready || !this.iframe?.contentWindow) return;

      const now = performance.now();
      // Recover from a worker-side exception or a dropped postMessage.
      if (this.busy && now - this.busySince < 1500) return;
      if (now - this.lastSent < CONFIG.DETECT_INTERVAL_MS) return;
      this.lastSent = now;
      this.busy = true;
      this.busySince = now;
      const requestId = ++this.requestId;

      // Downscale frame for fast detection (320px wide)
      const scale = Math.min(1.0, 320 / w);
      const dw = Math.round(w * scale);
      const dh = Math.round(h * scale);

      createImageBitmap(canvas, { resizeWidth: dw, resizeHeight: dh })
        .then((bitmap) => {
          this.iframe.contentWindow.postMessage(
            {
              type: "PROCESS_FRAME",
              bitmap,
              width: dw,
              height: dh,
              timestamp: now,
              requestId,
            },
            "*",
            [bitmap]
          );
        })
        .catch(() => {
          if (requestId === this.requestId) this.busy = false;
        });
    }
  }

  const gestureClient = new GestureClient();

  // ======================================================================
  // FRAME PROCESSOR
  // ======================================================================
  class FrameProcessor {
    constructor(stream) {
      this.srcStream = stream;
      this.vTrack = stream.getVideoTracks()[0];
      const s = this.vTrack ? this.vTrack.getSettings() : {};
      this.w = (s && s.width) || 640;
      this.h = (s && s.height) || 480;

      // hidden video
      this.vid = document.createElement("video");
      this.vid.muted = true;
      this.vid.playsInline = true;
      this.vid.autoplay = true;
      this.vid.srcObject = new MediaStream([this.vTrack]);

      // canvases
      this.live = this._canvas(this.w, this.h);
      this.out = this._canvas(this.w, this.h);
      this.bg = this._canvas(this.w, this.h);
      this.lCtx = this.live.getContext("2d");
      this.oCtx = this.out.getContext("2d");
      this.bCtx = this.bg.getContext("2d");
      this.bgOk = false;

      // Pre-fill black so captureStream() has initial valid pixel buffer
      this.lCtx.fillStyle = "#000000";
      this.lCtx.fillRect(0, 0, this.w, this.h);
      this.oCtx.fillStyle = "#000000";
      this.oCtx.fillRect(0, 0, this.w, this.h);
      this.bCtx.fillStyle = "#000000";
      this.bCtx.fillRect(0, 0, this.w, this.h);

      this.vid.addEventListener("loadedmetadata", () => {
        if (this.vid.videoWidth && this.vid.videoHeight) {
          this.w = this.vid.videoWidth;
          this.h = this.vid.videoHeight;
          this.live.width = this.w;
          this.live.height = this.h;
          this.out.width = this.w;
          this.out.height = this.h;
          this.bg.width = this.w;
          this.bg.height = this.h;
        }
      });

      this.vid.play().catch(() => {});

      // output stream (canvas → WebRTC)
      this.outStream = this.out.captureStream(30);
      for (const t of stream.getAudioTracks()) this.outStream.addTrack(t);

      // WebRTC Track Proxy to prevent errors on OmeTV/Zoom/Teams
      const outTrack = this.outStream.getVideoTracks()[0];
      if (outTrack && this.vTrack) {
        const origStop = outTrack.stop.bind(outTrack);
        outTrack.stop = () => {
          origStop();
          this.stop();
        };

        outTrack.applyConstraints = async (constraints) => {
          try {
            if (this.vTrack.applyConstraints) {
              await this.vTrack.applyConstraints(constraints);
            }
          } catch (_) {}
          return Promise.resolve();
        };

        outTrack.getCapabilities = () => {
          return this.vTrack.getCapabilities ? this.vTrack.getCapabilities() : {};
        };

        outTrack.getSettings = () => {
          const orig = this.vTrack.getSettings ? this.vTrack.getSettings() : {};
          return {
            ...orig,
            width: this.w,
            height: this.h,
            frameRate: 30,
          };
        };

        try {
          Object.defineProperty(outTrack, "label", {
            get: () => this.vTrack.label || "Instant Transmission Virtual Cam",
            configurable: true,
          });
        } catch (_) {}
      }

      this._running = true;
      this._raf = null;
      this._tick = this._tick.bind(this);
      this._tick();
    }

    _canvas(w, h) {
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      return c;
    }

    captureBg() {
      if (this.vid.readyState >= 2) {
        this.lCtx.drawImage(this.vid, 0, 0, this.w, this.h);
        this.bCtx.drawImage(this.live, 0, 0);
        this.bgOk = true;
        console.log("[IT] Background captured ✔");
        _showToast("⚡ Background Captured!");
        _broadcastState();
        return true;
      }
      return false;
    }

    _tick() {
      if (!this._running) return;
      this._raf = requestAnimationFrame(this._tick);
      if (this.vid.readyState < 2) return;

      const { w, h } = this;
      const now = performance.now() / 1000;

      // draw live frame
      this.lCtx.drawImage(this.vid, 0, 0, w, h);

      // fallback BG
      if (!this.bgOk) {
        this.bCtx.filter = "blur(20px)";
        this.bCtx.drawImage(this.live, 0, 0);
        this.bCtx.filter = "none";
      }

      // Send frame to gesture detector (MediaPipe in iframe)
      if (state.enabled && !state.effectActive) {
        gestureClient.sendFrame(this.live, w, h);
      }

      // advance keyboard charge if active
      if (state.charging && state.visible && !state.effectActive) {
        const elapsed = (performance.now() - state.chargeStart) / 1000;
        state.chargeFrac = Math.min(elapsed / CONFIG.HOLD_SECONDS, 1);
        if (state.chargeFrac >= 1) {
          state.charging = false;
          state.chargeFrac = 0;
          this._trigger();
        }
      }

      // render
      if (state.effectActive) {
        if (!state.effectActive.render(this.oCtx, this.live, this.bg, now)) {
          state.effectActive = null;
        }
      } else if (state.visible) {
        this.oCtx.drawImage(this.live, 0, 0);
        if (state.chargeFrac > 0) drawAura(this.oCtx, w, h, state.chargeFrac);
      } else {
        this.oCtx.drawImage(this.bg, 0, 0);
      }
    }

    _trigger() {
      state.visible = !state.visible;
      state.effectActive = new TeleportEffect(this.w, this.h, !state.visible);
      playTeleportSound();
      _broadcastState();
    }

    stop() {
      this._running = false;
      if (this._raf) cancelAnimationFrame(this._raf);
      if (this.vid) this.vid.srcObject = null;
      if (this.vTrack) {
        try { this.vTrack.stop(); } catch (_) {}
      }
      if (this.srcStream) {
        try { this.srcStream.getTracks().forEach((t) => t.stop()); } catch (_) {}
      }
      processor = null;
      _broadcastState();
    }
  }

  // ======================================================================
  // ON-SCREEN TOAST
  // ======================================================================
  function _showToast(text) {
    let t = document.getElementById("it-toast");
    if (!t) {
      t = document.createElement("div");
      t.id = "it-toast";
      const S = t.style;
      S.position = "fixed";
      S.top = "20px";
      S.left = "50%";
      S.transform = "translateX(-50%)";
      S.background = "linear-gradient(135deg,#0d1117,#161b22)";
      S.color = "#81d4fa";
      S.border = "1.5px solid #4fc3f7";
      S.padding = "8px 18px";
      S.borderRadius = "20px";
      S.fontSize = "13px";
      S.fontWeight = "600";
      S.zIndex = "2147483647";
      S.boxShadow = "0 0 16px rgba(79,195,247,0.5)";
      S.transition = "all 0.3s ease";
      S.pointerEvents = "none";
      document.body.appendChild(t);
    }
    t.textContent = text;
    t.style.opacity = "1";
    clearTimeout(t._timer);
    t._timer = setTimeout(() => {
      t.style.opacity = "0";
    }, 2200);
  }

  // ======================================================================
  // getUserMedia HOOK
  // ======================================================================
  let processor = null;
  const _origGUM = navigator.mediaDevices.getUserMedia.bind(
    navigator.mediaDevices
  );

  navigator.mediaDevices.getUserMedia = async function (constraints) {
    const stream = await _origGUM(constraints);
    if (!state.enabled || !constraints?.video) return stream;

    if (processor) processor.stop();
    processor = new FrameProcessor(stream);
    console.log(
      "[IT] ⚡ Camera hooked — Instant Transmission ready!\n" +
        "     🤞 Put two fingers to your forehead to vanish/reappear.\n" +
        "     ⌨ Or hold Alt+G. Alt+B to capture clean background."
    );
    _showToast("⚡ Instant Transmission Ready!");
    _broadcastState();
    return processor.outStream;
  };

  // Polyfill / Hook legacy APIs used by older video chat sites
  if (navigator.getUserMedia) {
    navigator.getUserMedia = function (constraints, success, error) {
      navigator.mediaDevices.getUserMedia(constraints).then(success).catch(error);
    };
  }
  if (navigator.webkitGetUserMedia) {
    navigator.webkitGetUserMedia = function (constraints, success, error) {
      navigator.mediaDevices.getUserMedia(constraints).then(success).catch(error);
    };
  }

  // ======================================================================
  // KEYBOARD
  // ======================================================================
  document.addEventListener("keydown", (e) => {
    if (!state.enabled || !processor) return;
    if (
      e.altKey &&
      e.code === CONFIG.HOTKEY &&
      !state.charging &&
      !state.effectActive
    ) {
      state.charging = true;
      state.chargeStart = performance.now();
      state.chargeFrac = 0;
      e.preventDefault();
    }
    if (e.altKey && e.code === CONFIG.BG_HOTKEY) {
      processor.captureBg();
      e.preventDefault();
    }
  });
  document.addEventListener("keyup", (e) => {
    if (e.code === CONFIG.HOTKEY && state.charging) {
      state.charging = false;
      state.chargeFrac = 0;
    }
  });

  // ======================================================================
  // MESSAGE BUS (popup ↔ bridge ↔ hook)
  // ======================================================================
  function _broadcastState() {
    window.postMessage(
      {
        type: "IT_STATE",
        visible: state.visible,
        enabled: state.enabled,
        bgCaptured: processor?.bgOk || false,
        cameraActive: !!(processor && processor._running),
        gestureReady: state.gestureReady,
      },
      "*"
    );
  }

  window.addEventListener("message", (e) => {
    if (!e.data?.type) return;

    if (e.data.type === "IT_INIT_CONFIG" && e.data.workerUrl) {
      state.workerUrl = e.data.workerUrl;
      gestureClient.init(state.workerUrl);
      return;
    }

    if (!e.data.type.startsWith("IT_")) return;

    switch (e.data.type) {
      case "IT_TOGGLE":
        if (processor && !state.effectActive) {
          processor._trigger();
        } else if (!processor) {
          _showToast("Turn on your camera in the call first!");
        }
        break;
      case "IT_CAPTURE_BG":
        if (processor && processor._running) {
          const ok = processor.captureBg();
          window.postMessage({ type: "IT_CAPTURE_BG_REPLY", success: ok }, "*");
        } else {
          _showToast("Turn on your camera in the call first!");
          window.postMessage(
            {
              type: "IT_CAPTURE_BG_REPLY",
              success: false,
              error: "Camera not active yet. Start video in your call first!",
            },
            "*"
          );
        }
        break;
      case "IT_SET_ENABLED":
        state.enabled = !!e.data.enabled;
        _broadcastState();
        break;
      case "IT_GET_STATE":
        _broadcastState();
        break;
    }
  });

  // ======================================================================
  // FLOATING ⚡ BUTTON
  // ======================================================================
  function _injectBtn() {
    if (document.getElementById("it-btn")) return;
    const b = document.createElement("button");
    b.id = "it-btn";
    b.type = "button";
    b.setAttribute("aria-label", "Instant Transmission");
    b.innerHTML = "⚡";
    b.title = "Instant Transmission — Hold 2 fingers to forehead, Alt+G, or click";
    const S = b.style;
    S.position = "fixed";
    S.bottom = "90px";
    S.right = "24px";
    S.width = "48px";
    S.height = "48px";
    S.borderRadius = "50%";
    S.background = "linear-gradient(135deg,#0d1117,#161b22)";
    S.border = "2px solid #4fc3f7";
    S.display = "flex";
    S.alignItems = "center";
    S.justifyContent = "center";
    S.fontSize = "22px";
    S.cursor = "pointer";
    S.zIndex = "2147483647";
    S.boxShadow = "0 0 14px rgba(79,195,247,.4)";
    S.transition = "all .2s";
    S.userSelect = "none";
    S.pointerEvents = "auto";
    S.touchAction = "manipulation";
    S.padding = "0";
    S.fontFamily = "inherit";
    S.lineHeight = "1";
    b.onmouseenter = () => {
      S.transform = "scale(1.15)";
      S.boxShadow = "0 0 24px rgba(79,195,247,.7)";
    };
    b.onmouseleave = () => {
      S.transform = "";
      S.boxShadow = "0 0 14px rgba(79,195,247,.4)";
    };
    b.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (processor && !state.effectActive) {
        processor._trigger();
        S.borderColor = state.visible ? "#4fc3f7" : "#ff5722";
      }
    });
    document.body.appendChild(b);
  }

  if (document.body) _injectBtn();
  else
    new MutationObserver((_, o) => {
      if (document.body) {
        _injectBtn();
        o.disconnect();
      }
    }).observe(document.documentElement, { childList: true, subtree: true });

  console.log("[Instant Transmission] ⚡ Extension loaded, waiting for camera…");
})();
