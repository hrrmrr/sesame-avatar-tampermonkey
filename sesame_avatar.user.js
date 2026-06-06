// ==UserScript==
// @name         Sesame – Maya/Miles Avatar Overlay + Audio Waveform
// @namespace    http://tampermonkey.net/
// @version      6.0
// @description  Overlays an avatar image with a circular audio waveform that pulses on audio detection
// @author       Claude AI
// @match        https://app.sesame.com/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  // ─── CONFIG ────────────────────────────────────────────────────────────────
  const AVATARS = {
    Maya:  'https://i.imgur.com/2z0W0DY.png',
    Miles: 'https://i.imgur.com/bEu3ss2.jpeg',
  };

  const CFG = {
    BARS:          80,
    RADIUS:        110,
    BAR_MAX:       75,
    BAR_MIN:       3,
    LINE_WIDTH:    2.5,
    AUDIO_THRESH:  6,      // 0–255 avg frequency level
    AUDIO_HOLD_MS: 300,    // ms to hold "active" after signal drops
    PULSE_MIN:     1.0,
    PULSE_MAX:     1.06,
    PULSE_SPEED:   6,
    COLOR_MAYA:    '#c084fc',
    COLOR_MILES:   '#67e8f9',
    COLOR_IDLE:    '#94a3b8',
    OVERLAY_SIZE:  280,
    IMG_SIZE:      160,
  };
  // ───────────────────────────────────────────────────────────────────────────

  let currentAgent  = null;
  let animFrame     = null;
  let overlay       = null;
  let waveCanvas    = null;
  let ctx2d         = null;
  let imgEl         = null;
  let pulseT        = 0;
  let lastFrameTime = null;
  let audioLastSeen = 0;

  // Our own AudioContext used solely for analysis — never touches mic
  let ourAC       = null;
  let analyser    = null;

  const hookedStreams = new WeakSet();

  // ── 1. TAP WEBRTC INCOMING AUDIO ─────────────────────────────────────────
  // Sesame uses RTCPeerConnection for voice. The remote audio arrives as a
  // MediaStreamTrack via the `track` event. We pipe only REMOTE (incoming)
  // audio tracks into our own AudioContext analyser — we never touch the
  // mic/outgoing tracks, so there is zero feedback risk.

  function ensureAudioContext () {
    if (ourAC) return;
    ourAC   = new (window._NativeAudioContext || AudioContext)();
    analyser = ourAC.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.75;
    // analyser is NOT connected to ourAC.destination — read-only tap.
  }

  function tapRemoteTrack (track, streams) {
    // Only audio tracks; skip if we've seen this stream already
    if (track.kind !== 'audio') return;
    const stream = streams?.[0];
    if (!stream || hookedStreams.has(stream)) return;
    hookedStreams.add(stream);

    ensureAudioContext();

    // Resume context on first remote track (browsers require user gesture,
    // but by the time WebRTC connects the user has already interacted)
    if (ourAC.state === 'suspended') ourAC.resume().catch(() => {});

    const src = ourAC.createMediaStreamSource(stream);
    src.connect(analyser);
    // NOT connected to ourAC.destination → no audio playback, no feedback
  }

  function patchRTCPeerConnection () {
    const NativeRTC = window.RTCPeerConnection;
    if (!NativeRTC) return;

    // Store native AudioContext before any page script can overwrite it
    window._NativeAudioContext = window.AudioContext || window.webkitAudioContext;

    function PatchedRTC (...args) {
      const pc = new NativeRTC(...args);

      // Listen for incoming tracks
      pc.addEventListener('track', (e) => {
        tapRemoteTrack(e.track, e.streams);
      });

      // Also patch addTrack / addStream in case the page routes audio differently
      const origAddTrack = pc.addTrack?.bind(pc);
      if (origAddTrack) {
        pc.addTrack = function (track, ...streams) {
          // addTrack is OUTGOING (local mic) — do not tap
          return origAddTrack(track, ...streams);
        };
      }

      return pc;
    }

    PatchedRTC.prototype             = NativeRTC.prototype;
    PatchedRTC.generateCertificate   = NativeRTC.generateCertificate?.bind(NativeRTC);
    window.RTCPeerConnection         = PatchedRTC;
  }

  // ── 2. TARGET CANVAS ─────────────────────────────────────────────────────
  function getTargetCanvas () { return document.getElementById('dat-canvas'); }

  function setNativeCanvasVisible (visible) {
    const t = getTargetCanvas();
    if (t) t.style.visibility = visible ? '' : 'hidden';
  }

  function positionOverlay () {
    if (!overlay) return;
    const target = getTargetCanvas();
    if (!target) { overlay.style.display = 'none'; return; }
    const rect = target.getBoundingClientRect();
    const size = CFG.OVERLAY_SIZE;
    overlay.style.display = 'block';
    overlay.style.left = (rect.left + window.scrollX + rect.width  / 2 - size / 2) + 'px';
    overlay.style.top  = (rect.top  + window.scrollY + rect.height / 2 - size / 2 + 16) + 'px';
  }

  // ── 3. OVERLAY DOM ───────────────────────────────────────────────────────
  function buildOverlay () {
    if (overlay) return;

    overlay = document.createElement('div');
    Object.assign(overlay.style, {
      position: 'absolute', width: CFG.OVERLAY_SIZE + 'px', height: CFG.OVERLAY_SIZE + 'px',
      zIndex: '2147483647', pointerEvents: 'none', display: 'none',
      opacity: '0', transition: 'opacity 0.45s ease',
    });

    waveCanvas = document.createElement('canvas');
    waveCanvas.width = waveCanvas.height = CFG.OVERLAY_SIZE;
    Object.assign(waveCanvas.style, { position: 'absolute', top: '0', left: '0' });
    ctx2d = waveCanvas.getContext('2d');

    imgEl = document.createElement('img');
    const off = (CFG.OVERLAY_SIZE - CFG.IMG_SIZE) / 2;
    Object.assign(imgEl.style, {
      position: 'absolute', width: CFG.IMG_SIZE + 'px', height: CFG.IMG_SIZE + 'px',
      top: off + 'px', left: off + 'px', borderRadius: '50%', objectFit: 'cover',
      boxShadow: '0 0 32px rgba(0,0,0,0.45)', transformOrigin: 'center center',
      transform: 'scale(1)',
    });

    overlay.appendChild(waveCanvas);
    overlay.appendChild(imgEl);
    document.body.style.position = document.body.style.position || 'relative';
    document.body.appendChild(overlay);
  }

  // ── 4. SHOW / HIDE ───────────────────────────────────────────────────────
  function showOverlay (agent) {
    buildOverlay();
    imgEl.src = AVATARS[agent] || '';
    positionOverlay();
    overlay.style.opacity = '1';
    setNativeCanvasVisible(false);
    startDraw(agent);
  }

  function hideOverlay () {
    if (!overlay) return;
    overlay.style.opacity = '0';
    setNativeCanvasVisible(true);
    stopDraw();
  }

  // ── 5. DRAW LOOP ─────────────────────────────────────────────────────────
  function startDraw (agent) {
    stopDraw();
    lastFrameTime = null;
    pulseT        = 0;
    audioLastSeen = 0;
    const color = agent === 'Maya' ? CFG.COLOR_MAYA
                : agent === 'Miles' ? CFG.COLOR_MILES
                : CFG.COLOR_IDLE;
    scheduleDraw(color);
  }

  function stopDraw () {
    if (animFrame) { cancelAnimationFrame(animFrame); animFrame = null; }
  }

  function scheduleDraw (color) {
    animFrame = requestAnimationFrame(ts => {
      const dt = lastFrameTime ? (ts - lastFrameTime) / 1000 : 0;
      lastFrameTime = ts;
      drawFrame(color, dt, ts);
      scheduleDraw(color);
    });
  }

  function drawFrame (color, dt, now) {
    positionOverlay();

    const W = waveCanvas.width, H = waveCanvas.height, cx = W / 2, cy = H / 2;
    ctx2d.clearRect(0, 0, W, H);

    let dataArr  = new Uint8Array(analyser ? analyser.frequencyBinCount : 128);
    let avgLevel = 0;

    if (analyser) {
      analyser.getByteFrequencyData(dataArr);
      avgLevel = dataArr.reduce((s, v) => s + v, 0) / dataArr.length;
    }

    if (avgLevel > CFG.AUDIO_THRESH) audioLastSeen = now;
    const audioActive = (now - audioLastSeen) < CFG.AUDIO_HOLD_MS;

    // Bars
    for (let i = 0; i < CFG.BARS; i++) {
      const angle = (i / CFG.BARS) * Math.PI * 2 - Math.PI / 2;
      let barH;

      if (audioActive && analyser) {
        const bin = Math.floor((i / CFG.BARS) * (dataArr.length * 0.4));
        barH = CFG.BAR_MIN + (dataArr[bin] / 255) * CFG.BAR_MAX;
      } else {
        barH = CFG.BAR_MIN;
      }

      const x1 = cx + Math.cos(angle) * CFG.RADIUS;
      const y1 = cy + Math.sin(angle) * CFG.RADIUS;

      ctx2d.shadowColor = color;
      ctx2d.shadowBlur  = audioActive ? 10 : 3;
      ctx2d.beginPath();
      ctx2d.moveTo(x1, y1);
      ctx2d.lineTo(
        cx + Math.cos(angle) * (CFG.RADIUS + barH),
        cy + Math.sin(angle) * (CFG.RADIUS + barH)
      );
      ctx2d.strokeStyle = audioActive ? color : color + '55';
      ctx2d.lineWidth   = CFG.LINE_WIDTH;
      ctx2d.lineCap     = 'round';
      ctx2d.stroke();
    }

    // Base ring
    ctx2d.shadowBlur = 0;
    ctx2d.beginPath();
    ctx2d.arc(cx, cy, CFG.RADIUS, 0, Math.PI * 2);
    ctx2d.strokeStyle = color + '33';
    ctx2d.lineWidth   = 1;
    ctx2d.stroke();

    // Avatar pulse
    if (audioActive) {
      pulseT += dt * CFG.PULSE_SPEED;
      const pulse = CFG.PULSE_MIN + (Math.sin(pulseT) * 0.5 + 0.5) * (CFG.PULSE_MAX - CFG.PULSE_MIN);
      imgEl.style.transform = `scale(${pulse.toFixed(4)})`;
    } else {
      pulseT = 0;
      imgEl.style.transform = 'scale(1)';
    }
  }

  // ── 6. AGENT DETECTION ───────────────────────────────────────────────────
  function detectAgent () {
    const bodyText = document.body ? (document.body.innerText || '') : '';
    if (/thank you for talking to/i.test(bodyText)) {
      if (currentAgent !== null) { currentAgent = null; hideOverlay(); }
      return;
    }
    const candidates = document.querySelectorAll(
      'h1, h2, h3, header, [class*="header"], [class*="title"], [class*="agent"], [class*="name"]'
    );
    let found = null;
    for (const el of candidates) {
      const text = el.textContent || '';
      if (/\bMaya\b/i.test(text))  { found = 'Maya';  break; }
      if (/\bMiles\b/i.test(text)) { found = 'Miles'; break; }
    }
    if (found !== currentAgent) {
      currentAgent = found;
      if (found) showOverlay(found);
      else       hideOverlay();
    }
  }

  // ── 7. INIT ──────────────────────────────────────────────────────────────
  patchRTCPeerConnection();

  function init () {
    buildOverlay();
    detectAgent();
    new MutationObserver(() => {
      detectAgent();
      if (currentAgent) positionOverlay();
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
    window.addEventListener('scroll', () => { if (currentAgent) positionOverlay(); }, { passive: true });
    window.addEventListener('resize', () => { if (currentAgent) positionOverlay(); }, { passive: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
