; (function () {
  'use strict';
  try {
    /* confetti.js - the confetti burst, drawn on a throwaway full-viewport canvas.
       Exposes window.Card.confetti(x, y) (viewport coordinates; defaults to the centre).
       Tears itself down after at most 3 s, and immediately on 'closed'. */

    var Card = window.Card;
    var doc = document;

    var COLORS = ['#ff9ec4', '#ffc2da', '#ffd6e5', '#a8e6cf', '#c8f1df', '#ffe69a', '#fff1b8', '#c9b6f2', '#a9d8f5', '#ffc9a8'];
    var MAX_LIFE = 2800;    // ms; hard stop is 3000

    var cvs = null, ctx = null, parts = [], raf = 0, sweepTimer = null, cw = 0, ch = 0, dpr = 1, lastT = 0;

    function rnd(a, b) {return a + Math.random() * (b - a);}

    function teardown() {
      if (raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf);
      raf = 0;
      if (sweepTimer) {clearTimeout(sweepTimer); sweepTimer = null;}
      if (cvs && cvs.parentNode) cvs.parentNode.removeChild(cvs);
      cvs = null; ctx = null; parts = [];
    }

    function nowMs() {
      return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    }

    function sweep() {
      var t = nowMs();
      parts = parts.filter(function (p) {return t - p.t0 < p.life;});
      if (!parts.length) teardown();
    }

    function frame(ts) {
      raf = 0;
      if (!cvs || !ctx) return;
      var t = nowMs();
      var dt = Math.min(0.05, Math.max(0.001, (t - lastT) / 1000));
      lastT = t;

      ctx.clearRect(0, 0, cw, ch);
      var alive = [];
      for (var i = 0; i < parts.length; i++) {
        var p = parts[i];
        var age = t - p.t0;
        if (age >= p.life) continue;
        var drag = Math.exp(-p.drag * dt);
        p.vx *= drag;
        p.vy = p.vy * drag + p.g * dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.rot += p.spin * dt;
        p.flip += p.flipSpeed * dt;

        var left = p.life - age;
        var a = left < 450 ? left / 450 : 1;
        ctx.globalAlpha = a < 0 ? 0 : a;
        ctx.fillStyle = p.color;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.scale(1, p.flat ? 1 : Math.cos(p.flip));
        if (p.round) {
          ctx.beginPath();
          ctx.arc(0, 0, p.w / 2, 0, 6.2832);
          ctx.fill();
        } else {
          ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        }
        ctx.restore();
        alive.push(p);
      }
      ctx.globalAlpha = 1;
      parts = alive;
      if (parts.length) raf = requestAnimationFrame(frame);
      else teardown();
    }

    function confetti(x, y) {
      var vw = window.innerWidth || doc.documentElement.clientWidth || 360;
      var vh = window.innerHeight || doc.documentElement.clientHeight || 640;
      if (typeof x !== 'number' || !isFinite(x)) x = vw / 2;
      if (typeof y !== 'number' || !isFinite(y)) y = vh / 2;
      var calm = !!Card.reducedMotion;

      if (!cvs) {
        cvs = doc.createElement('canvas');
        cvs.className = 'bdc-confetti';
        cvs.setAttribute('aria-hidden', 'true');
        doc.body.appendChild(cvs);
        cw = cvs.clientWidth || vw;
        ch = cvs.clientHeight || vh;
        dpr = Math.min(2, window.devicePixelRatio || 1);
        cvs.width = Math.round(cw * dpr);
        cvs.height = Math.round(ch * dpr);
        ctx = cvs.getContext('2d');
        if (!ctx) {teardown(); return;}
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      }

      var count = calm ? 28 : 80;
      var t0 = nowMs();
      var scale = Math.max(0.7, Math.min(1.2, Math.min(cw, ch) / 600));   // smaller screens, smaller bursts
      for (var i = 0; i < count; i++) {
        var ang = calm ? rnd(-Math.PI * 0.85, -Math.PI * 0.15) : rnd(0, Math.PI * 2);
        var sp = calm ? rnd(120, 340) : rnd(180, 820);
        var vx = Math.cos(ang) * sp * scale;
        var vy = Math.sin(ang) * sp * scale - (calm ? 40 : 260) * scale;   // upward bias
        var kind = Math.random();
        parts.push({
          x: x, y: y, vx: vx, vy: vy,
          g: (calm ? 420 : 1000) * scale,
          drag: calm ? 1.8 : 1.5,
          rot: rnd(0, 6.28),
          spin: calm ? 0 : rnd(-14, 14),
          flip: rnd(0, 6.28),
          flipSpeed: calm ? 0 : rnd(4, 12),
          flat: calm,
          w: (kind < 0.25 ? rnd(6, 9) : rnd(7, 12)) * (calm ? 0.9 : 1),
          h: kind < 0.25 ? rnd(6, 9) : (kind < 0.6 ? rnd(4, 6) : rnd(9, 15)),
          round: kind < 0.25,
          color: COLORS[(Math.random() * COLORS.length) | 0],
          t0: t0,
          life: calm ? rnd(1400, 2000) : rnd(1800, MAX_LIFE)
        });
      }

      // the hard stop works even if animation frames are throttled (background tab)
      if (sweepTimer) clearTimeout(sweepTimer);
      sweepTimer = setTimeout(function () {
        sweepTimer = null;
        parts = [];
        teardown();
      }, 3000);
      if (!raf && typeof requestAnimationFrame === 'function') {lastT = t0; raf = requestAnimationFrame(frame);}
    }

    Card.confetti = confetti;
    Card.on('closed', teardown);

  } catch (err) {console.error('[confetti] failed to load:', err);}
})();
