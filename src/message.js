; (function () {
  'use strict';
  try {
    /* message.js - typewriter reveal of the note (on 'popupDone') and the confetti burst.
       Exposes window.Card.message = { reveal() } and window.Card.confetti(x, y). */

    var Card = window.Card;
    var CONFIG = window.CONFIG || {};
    var doc = document;
    var root = doc.getElementById('message');

    var MAIN = "Morlai and I tried to bake you a cake. Legally, this is a cake. You're still the sweetest thing in the world!";
    var LATE = 'Happy birthday!\u00a0\uD83D\uDC95';   // "Happy birthday! 💕": held back until the candles are out (with "Love, ..." and the date); the NBSP keeps "!" and the heart on one line
    var EMPHASIS = 'Legally, this is a cake.';

    var CHAR_MS = 25;      // per character
    var PAUSE_END = 260;   // after . ! ?
    var PAUSE_MID = 120;   // after , ; :
    var LATE_DELAY = 1400; // after 'candlesOut', so the finale lands after the confetti

    /* ====================================================================== message */
    var greetEl, bodyEl, signEl, dateEl, footEl, lateEl;
    var chars = [];        // [{ el, ch, em }] typed on popupDone: greeting + main body only
    var lateChars = [];    // the characters of "Happy birthday! 💕" (popped in after candlesOut)
    var emEls = [];
    var caret = null;
    var timer = null;
    var lateTimer = null;
    var status = 'idle';   // 'idle' | 'typing' | 'done'
    var lateShown = false;
    var latePending = false;   // candlesOut came while the main text was still typing
    var builtFor = '';

    function mk(tag, cls) {
      var e = doc.createElement(tag);
      if (cls) e.className = cls;
      return e;
    }

    /* Fill `vis` with word wrappers and one span per character (spaces stay plain text
       so lines wrap normally). Pushes the character records into `list`. */
    function fillVis(vis, str, emStart, emEnd, list) {
      var i = 0, n = str.length, emIdx = 0, idx = 0;
      while (i < n) {
        if (str.charAt(i) === ' ') {
          vis.appendChild(doc.createTextNode(' '));
          i++;
          continue;
        }
        var w = mk('span', 'msg-w');
        while (i < n && str.charAt(i) !== ' ') {
          var c = mk('span', 'msg-ch');
          var cu = str.charAt(i);
          var cc = str.charCodeAt(i);
          if (cc >= 0xD800 && cc <= 0xDBFF && i + 1 < n) cu += str.charAt(i + 1);   // keep surrogate pairs (emoji) whole
          c.textContent = cu;
          c.style.setProperty('--i', String(idx++));
          var em = emStart >= 0 && i >= emStart && i < emEnd;
          if (em) {
            c.className += ' msg-em';
            c.style.setProperty('--i', String(emIdx++));
            emEls.push(c);
          }
          w.appendChild(c);
          list.push({el: c, ch: cu, em: em, last: em && i === emEnd - 1});
          i += cu.length;
        }
        vis.appendChild(w);
      }
    }

    /* a typed block: one sr-only copy for screen readers + one aria-hidden visual copy */
    function fill(host, str, emStart, emEnd, list) {
      host.textContent = '';
      var sr = mk('span', 'sr-only');
      sr.textContent = str;
      var vis = mk('span', null);
      vis.setAttribute('aria-hidden', 'true');
      host.appendChild(sr);
      host.appendChild(vis);
      fillVis(vis, str, emStart, emEnd, list);
      return vis;
    }

    /* The delayed parts keep their layout space (visibility/opacity, never display:none) and are
       aria-hidden, so neither sighted nor screen-reader users get them before the candles are out. */
    function setLate(on) {
      lateShown = on;
      var parts = [lateEl, signEl, dateEl];
      for (var i = 0; i < parts.length; i++) {
        var el = parts[i];
        if (!el) continue;
        if (on) {el.classList.add('msg-on'); el.removeAttribute('aria-hidden');}
        else {el.classList.remove('msg-on'); el.setAttribute('aria-hidden', 'true');}
      }
      for (var k = 0; k < lateChars.length; k++) lateChars[k].el.classList.remove('msg-pop');
      if (on) {
        void root.offsetWidth;   // restart the pop after a replay
        for (var j = 0; j < lateChars.length; j++) lateChars[j].el.classList.add('msg-pop');
      }
    }

    function stopLateTimer() {
      if (lateTimer) {clearTimeout(lateTimer); lateTimer = null;}
    }

    function build() {
      if (!root) return;
      greetEl = root.querySelector('.msg-greet');
      bodyEl = root.querySelector('.msg-body');
      signEl = root.querySelector('.msg-sign');
      dateEl = root.querySelector('.msg-date');
      footEl = root.querySelector('.msg-foot');
      if (!greetEl || !bodyEl || !signEl || !dateEl) return;

      stopLateTimer();
      chars = [];
      lateChars = [];
      emEls = [];
      caret = null;
      latePending = false;

      var to = CONFIG.to ? 'Dear ' + CONFIG.to + ',' : '';
      var from = CONFIG.from ? 'Love, ' + CONFIG.from : '';
      var date = CONFIG.date ? String(CONFIG.date) : '';

      fill(greetEl, to, -1, -1, chars);

      // body: [sr main][vis main] + [late wrapper: sr copy + vis copy]; the wrapper is the only part toggled
      bodyEl.textContent = '';
      var srMain = mk('span', 'sr-only');
      srMain.textContent = MAIN + ' ';
      var visMain = mk('span', null);
      visMain.setAttribute('aria-hidden', 'true');
      bodyEl.appendChild(srMain);
      bodyEl.appendChild(visMain);
      var es = MAIN.indexOf(EMPHASIS);
      fillVis(visMain, MAIN, es, es < 0 ? -1 : es + EMPHASIS.length, chars);
      visMain.appendChild(doc.createTextNode(' '));
      lateEl = mk('span', 'msg-late');
      var srLate = mk('span', 'sr-only');
      srLate.textContent = LATE.replace(/\u00a0/g, ' ');
      var visLate = mk('span', null);
      visLate.setAttribute('aria-hidden', 'true');
      lateEl.appendChild(srLate);
      lateEl.appendChild(visLate);
      bodyEl.appendChild(lateEl);
      fillVis(visLate, LATE, -1, -1, lateChars);
      for (var i = 0; i < lateChars.length; i++) lateChars[i].el.classList.add('msg-on');

      // sign-off and date: a single copy each (no duplicate text), hidden as a whole
      signEl.textContent = from;
      dateEl.textContent = date;
      greetEl.hidden = !to;
      signEl.hidden = !from;
      dateEl.hidden = !date;
      setLate(false);
      builtFor = [to, from, date].join('|');
    }

    function stopTimer() {
      if (timer) {clearTimeout(timer); timer = null;}
    }

    function removeCaret() {
      if (caret && caret.parentNode) caret.parentNode.removeChild(caret);
      caret = null;
    }

    function showAll() {
      for (var i = 0; i < chars.length; i++) chars[i].el.classList.add('msg-on');
    }

    function finish() {
      stopTimer();
      removeCaret();
      status = 'done';
      if (latePending) {latePending = false; setLate(true);}
    }

    function wiggle() {
      for (var i = 0; i < emEls.length; i++) emEls[i].classList.add('msg-wiggle');
    }

    function typeNext(idx) {
      timer = null;
      if (status !== 'typing') return;
      if (idx >= chars.length) {finish(); return;}
      var item = chars[idx];
      item.el.classList.add('msg-on');
      if (!caret) caret = mk('span', 'msg-caret');
      var p = item.el.parentNode;
      p.insertBefore(caret, item.el.nextSibling);
      if (item.last) wiggle();

      var next = idx + 1;
      var wait = CHAR_MS;
      var atEnd = next >= chars.length || chars[next].el.parentNode.parentNode.parentNode !== item.el.parentNode.parentNode.parentNode;
      if (/[.!?]/.test(item.ch)) wait += PAUSE_END;
      else if (/[,;:]/.test(item.ch)) wait += PAUSE_MID;
      if (atEnd && next < chars.length) wait += 180;   // short beat between greeting and body
      timer = setTimeout(function () {typeNext(next);}, wait);
    }

    function reveal() {
      if (!root || status !== 'idle') return;          // idempotent: never retype, keep shown
      var sig = [CONFIG.to ? 'Dear ' + CONFIG.to + ',' : '', CONFIG.from ? 'Love, ' + CONFIG.from : '', CONFIG.date ? String(CONFIG.date) : ''].join('|');
      if (!chars.length || sig !== builtFor) build();
      if (!chars.length) return;
      root.setAttribute('data-msg', 'on');
      if (Card.reducedMotion) {
        showAll();
        status = 'done';
        return;
      }
      status = 'typing';
      timer = setTimeout(function () {typeNext(0);}, 250);   // let the fade-in start first
    }

    /* candlesOut: after the confetti has landed, pop in "Happy birthday!", then the sign-off and date */
    function scheduleLate() {
      if (!root || lateShown) return;
      stopLateTimer();
      lateTimer = setTimeout(function () {
        lateTimer = null;
        if (Card.state === 'closed' || Card.state === 'closing' || lateShown) return;
        if (status === 'typing') {latePending = true; return;}   // never show it before the main text is done
        if (status === 'done') setLate(true);
      }, LATE_DELAY);
    }

    /* replay: the main part stays shown (not retyped); the delayed parts hide until the next candlesOut */
    function hideLate() {
      stopLateTimer();
      latePending = false;
      if (lateEl) setLate(false);
    }

    function reset() {
      stopTimer();
      removeCaret();
      hideLate();
      status = 'idle';
      if (root) root.removeAttribute('data-msg');
      for (var i = 0; i < chars.length; i++) {
        chars[i].el.classList.remove('msg-on');
        chars[i].el.classList.remove('msg-wiggle');
      }
    }

    build();

    Card.message = {reveal: reveal};

    Card.on('popupDone', function () {
      if (Card.state === 'closed' || Card.state === 'closing') return;
      reveal();
    });
    Card.on('candlesOut', scheduleLate);
    Card.on('replay', hideLate);
    Card.on('closing', function () {stopTimer(); stopLateTimer(); removeCaret();});  // no typing while the card folds shut
    Card.on('closed', reset);

    /* ====================================================================== confetti */
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

  } catch (err) {console.error('[message] failed to load:', err);}
})();
