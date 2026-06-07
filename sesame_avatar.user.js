// ==UserScript==
// @name         Sesame – Maya/Miles Avatar Overlay + Audio Waveform
// @namespace    http://tampermonkey.net/
// @version      6.0
// @description  Replaces #dat-canvas with avatar + circular waveform, driven by WebRTC audio.
// @author       Claude AI
// @match        https://app.sesame.com/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  // ─── CONFIG ────────────────────────────────────────────────────────────────
  const AVATARS = {
    Maya:   'https://i.imgur.com/2z0W0DY.png',
    Miles:  'https://i.imgur.com/bEu3ss2.jpeg',
    Simone: 'https://i.imgur.com/Ax8Ycjk.jpeg',
    Charlie:'https://i.imgur.com/5lEbqJ8.jpeg',
  };

  const CFG = {
    BARS:          80,
    RADIUS:        110,
    BAR_MAX:       40,
    BAR_MIN:       3,
    LINE_WIDTH:    2.5,
    AUDIO_THRESH:  6,
    AUDIO_HOLD_MS: 300,
    PULSE_MIN:     1.0,
    PULSE_MAX:     1.025,
    PULSE_SPEED:   6,
    ZOOM_ACTIVE:   1.08,   // object-position zoom when audio detected
    ZOOM_SPEED:    0.12,   // lerp speed for zoom transition
    LERP:          0.18,
    COLOR_MAYA:    '#c084fc',
    COLOR_MILES:   '#67e8f9',
    COLOR_SIMONE:  '#fb923c',
    COLOR_CHARLIE: '#4ade80',
    COLOR_IDLE:    '#94a3b8',
    OVERLAY_SIZE:  320,
    IMG_SIZE:      160,
  };

  const BANNER_TEXT = /this research preview is out of date/i;

  // ───────────────────────────────────────────────────────────────────────────

  let currentAgent  = null;
  let animFrame     = null;
  let overlay       = null;
  let waveCanvas    = null;
  let ctx2d         = null;
  let imgEl         = null;
  let zoomScale     = 1.0;  // current lerped zoom scale applied via transform on inner img
  let lastFrameTime = null;
  let audioLastSeen = 0;
  let lerpedBars    = new Float32Array(80);

  let ourAC          = null;
  let analyser       = null;
  const hookedStreams = new WeakSet();

  // ── 1. TAP WEBRTC INCOMING AUDIO ─────────────────────────────────────────
  function ensureAudioContext () {
    if (ourAC) return;
    ourAC    = new (window._NativeAudioContext || AudioContext)();
    analyser = ourAC.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.75;
  }

  function tapRemoteTrack (track, streams) {
    if (track.kind !== 'audio') return;
    const stream = streams?.[0];
    if (!stream || hookedStreams.has(stream)) return;
    hookedStreams.add(stream);
    ensureAudioContext();
    if (ourAC.state === 'suspended') ourAC.resume().catch(() => {});
    ourAC.createMediaStreamSource(stream).connect(analyser);
  }

  function patchRTCPeerConnection () {
    const NativeRTC = window.RTCPeerConnection;
    if (!NativeRTC) return;
    window._NativeAudioContext = window.AudioContext || window.webkitAudioContext;
    function PatchedRTC (...args) {
      const pc = new NativeRTC(...args);
      pc.addEventListener('track', e => tapRemoteTrack(e.track, e.streams));
      return pc;
    }
    PatchedRTC.prototype           = NativeRTC.prototype;
    PatchedRTC.generateCertificate = NativeRTC.generateCertificate?.bind(NativeRTC);
    window.RTCPeerConnection       = PatchedRTC;
  }

  // ── 2. BANNER SUPPRESSION ────────────────────────────────────────────────
  function findBannerEl () {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (BANNER_TEXT.test(node.textContent)) {
        // Walk up to the first block-level container
        let el = node.parentElement;
        while (el && el !== document.body) {
          const tag = el.tagName;
          if (tag === 'DIV' || tag === 'SECTION' || tag === 'ASIDE' || tag === 'ARTICLE') {
            // Return the next block-level ancestor above this one
            let parent = el.parentElement;
            while (parent && parent !== document.body) {
              const ptag = parent.tagName;
              if (ptag === 'DIV' || ptag === 'SECTION' || ptag === 'ASIDE' || ptag === 'ARTICLE') {
                return parent;
              }
              parent = parent.parentElement;
            }
            return el; // fallback to the inner one if no parent found
          }
          el = el.parentElement;
        }
      }
    }
    return null;
  }

  function hideBanner () {
    const el = findBannerEl();
    if (el && !el.dataset.sesameHidden) {
      el.dataset.sesameHidden = '1';
      el.style.display = 'none';
    }
  }

  function restoreBanner () {
    const el = document.querySelector('[data-sesame-hidden]');
    if (el) {
      el.style.display = '';
      delete el.dataset.sesameHidden;
    }
  }

  // ── 3. TARGET CANVAS ─────────────────────────────────────────────────────
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

  // ── 4. OVERLAY DOM ───────────────────────────────────────────────────────
  function buildOverlay () {
    if (overlay) return;

    overlay = document.createElement('div');
    overlay.setAttribute('aria-hidden', 'true');
    overlay.setAttribute('role', 'presentation');
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
      position:        'absolute',
      width:           CFG.IMG_SIZE + 'px',
      height:          CFG.IMG_SIZE + 'px',
      top:             off + 'px',
      left:            off + 'px',
      borderRadius:    '50%',
      objectFit:       'cover',
      overflow:        'hidden',
      boxShadow:       '0 0 32px rgba(0,0,0,0.45)',
      transformOrigin: 'center center',
      transform:       'scale(1)',
      transition:      'transform 0.15s ease-out, box-shadow 0.15s ease-out',
    });

    overlay.appendChild(waveCanvas);
    overlay.appendChild(imgEl);
    document.body.style.position = document.body.style.position || 'relative';
    document.body.appendChild(overlay);
  }

  // ── 5. SHOW / HIDE ───────────────────────────────────────────────────────
  function showOverlay (agent) {
    buildOverlay();
    imgEl.src = AVATARS[agent] || '';
    positionOverlay();
    overlay.style.opacity = '1';
    setNativeCanvasVisible(false);
    hideBanner();
    startDraw(agent);
  }

  function hideOverlay () {
    if (!overlay) return;
    overlay.style.opacity = '0';
    setNativeCanvasVisible(true);
    restoreBanner();
    stopDraw();
  }

  // ── 6. DRAW LOOP ─────────────────────────────────────────────────────────
  function startDraw (agent) {
    stopDraw();
    lastFrameTime = null;
    zoomScale     = 1.0;
    audioLastSeen = 0;
    lerpedBars    = new Float32Array(CFG.BARS);
    const color = agent === 'Maya'    ? CFG.COLOR_MAYA
                : agent === 'Miles'   ? CFG.COLOR_MILES
                : agent === 'Simone'  ? CFG.COLOR_SIMONE
                : agent === 'Charlie' ? CFG.COLOR_CHARLIE
                : CFG.COLOR_IDLE;
    scheduleDraw(color);
  }

  function stopDraw () {
    if (animFrame) { cancelAnimationFrame(animFrame); animFrame = null; }
  }

  function scheduleDraw (color) {
    animFrame = requestAnimationFrame(ts => {
      const dt = lastFrameTime ? Math.min((ts - lastFrameTime) / 1000, 0.1) : 0;
      lastFrameTime = ts;
      drawFrame(color, dt, ts);
      scheduleDraw(color);
    });
  }

  function drawFrame (color, dt, now) {
    positionOverlay();

    let dataArr  = new Uint8Array(analyser ? analyser.frequencyBinCount : 128);
    let avgLevel = 0;
    if (analyser) {
      analyser.getByteFrequencyData(dataArr);
      avgLevel = dataArr.reduce((s, v) => s + v, 0) / dataArr.length;
    }
    if (avgLevel > CFG.AUDIO_THRESH) audioLastSeen = now;
    const audioActive = (now - audioLastSeen) < CFG.AUDIO_HOLD_MS;

    // Lerped bar targets
    const lerp = Math.min(1, CFG.LERP + dt * 2);
    for (let i = 0; i < CFG.BARS; i++) {
      const bin    = Math.floor((i / CFG.BARS) * (dataArr.length * 0.4));
      const target = (audioActive && analyser)
        ? CFG.BAR_MIN + (dataArr[bin] / 255) * CFG.BAR_MAX
        : CFG.BAR_MIN;
      lerpedBars[i] += (target - lerpedBars[i]) * lerp;
    }

    // Waveform
    const W = waveCanvas.width, H = waveCanvas.height, cx = W / 2, cy = H / 2;
    ctx2d.clearRect(0, 0, W, H);

    for (let i = 0; i < CFG.BARS; i++) {
      const angle = (i / CFG.BARS) * Math.PI * 2 - Math.PI / 2;
      const barH  = lerpedBars[i];
      const x1    = cx + Math.cos(angle) * CFG.RADIUS;
      const y1    = cy + Math.sin(angle) * CFG.RADIUS;
      const x2    = cx + Math.cos(angle) * (CFG.RADIUS + barH);
      const y2    = cy + Math.sin(angle) * (CFG.RADIUS + barH);

      const grad = ctx2d.createLinearGradient(x1, y1, x2, y2);
      grad.addColorStop(0, audioActive ? color : color + '55');
      grad.addColorStop(1, '#000000');

      ctx2d.shadowColor = color;
      ctx2d.shadowBlur  = audioActive ? 10 : 3;
      ctx2d.beginPath();
      ctx2d.moveTo(x1, y1);
      ctx2d.lineTo(x2, y2);
      ctx2d.strokeStyle = grad;
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

    // Avatar zoom + box-shadow (image stays same visual size, content zooms in)
    const zoomTarget = audioActive ? CFG.ZOOM_ACTIVE : 1.0;
    zoomScale += (zoomTarget - zoomScale) * CFG.ZOOM_SPEED;

    const glowSize  = audioActive ? Math.round(8 + (zoomScale - 1) / (CFG.ZOOM_ACTIVE - 1) * 24) : 32;
    const glowAlpha = audioActive ? Math.round((0.35 + (zoomScale - 1) / (CFG.ZOOM_ACTIVE - 1) * 0.45) * 255).toString(16).padStart(2, '0') : '';
    imgEl.style.transform = `scale(${zoomScale.toFixed(4)})`;
    imgEl.style.boxShadow = audioActive
      ? `0 0 ${glowSize}px rgba(0,0,0,0.45), 0 0 ${glowSize}px ${color}${glowAlpha}`
      : '0 0 32px rgba(0,0,0,0.45)';
  }

  // ── 7. AGENT DETECTION ───────────────────────────────────────────────────
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
      if (/\bMaya\b/i.test(text))    { found = 'Maya';    break; }
      if (/\bMiles\b/i.test(text))   { found = 'Miles';   break; }
      if (/\bSimone\b/i.test(text))  { found = 'Simone';  break; }
      if (/\bCharlie\b/i.test(text)) { found = 'Charlie'; break; }
    }
    if (found !== currentAgent) {
      currentAgent = found;
      if (found) showOverlay(found);
      else       hideOverlay();
    }
  }

  // ── 8. INIT ──────────────────────────────────────────────────────────────
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
