; (function () {
  'use strict';
  try {
    /* message.js - typewriter reveal of the note: performs the message's beats of a Round (src/round.js).
       Exposes Card.message = { reveal(onTyped), showLate(), hideLate(), stop(), reset() }.
       The typewriter's per-character timing is local; when the late part shows (after the candles are
       out, and never before the main text has finished typing) is the Round's call: reveal() reports
       "typing finished" through onTyped and the Round calls showLate(). */

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

    /* ====================================================================== message */
    var greetEl, bodyEl, signEl, dateEl, footEl, lateEl;
    var chars = [];        // [{ el, ch, em }] typed on popupDone: greeting + main body only
    var lateChars = [];    // the characters of "Happy birthday! 💕" (popped in after candlesOut)
    var emEls = [];
    var caret = null;
    var timer = null;
    var status = 'idle';   // 'idle' | 'typing' | 'done'
    var lateShown = false;
    var onTyped = null;    // reveal()'s callback, called once the main text is fully shown
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

    function build() {
      if (!root) return;
      greetEl = root.querySelector('.msg-greet');
      bodyEl = root.querySelector('.msg-body');
      signEl = root.querySelector('.msg-sign');
      dateEl = root.querySelector('.msg-date');
      footEl = root.querySelector('.msg-foot');
      if (!greetEl || !bodyEl || !signEl || !dateEl) return;

      chars = [];
      lateChars = [];
      emEls = [];
      caret = null;

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
      typed();
    }

    function typed() {
      var cb = onTyped;
      onTyped = null;
      if (cb) cb();
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

    /* reveal(onTyped): type the greeting + main body; onTyped() once it is all shown. Idempotent: never
       retypes. Already shown -> onTyped() now; still typing (a replay mid-typing) -> onTyped() at the end. */
    function reveal(cb) {
      if (!root) return;
      if (status === 'done') {if (cb) cb(); return;}
      if (status === 'typing') {onTyped = cb || null; return;}
      var sig = [CONFIG.to ? 'Dear ' + CONFIG.to + ',' : '', CONFIG.from ? 'Love, ' + CONFIG.from : '', CONFIG.date ? String(CONFIG.date) : ''].join('|');
      if (!chars.length || sig !== builtFor) build();
      if (!chars.length) return;
      onTyped = cb || null;
      root.setAttribute('data-msg', 'on');
      if (Card.reducedMotion) {
        showAll();
        status = 'done';
        typed();
        return;
      }
      status = 'typing';
      timer = setTimeout(function () {typeNext(0);}, 250);   // let the fade-in start first
    }

    /* pop in "Happy birthday!", then the sign-off and date */
    function showLate() {
      if (!root || !lateEl || lateShown) return;
      setLate(true);
    }

    /* replay: the main part stays shown (not retyped); the delayed parts hide until the Round shows them again */
    function hideLate() {
      if (lateEl) setLate(false);
    }

    /* the card is folding shut: no typing while it does */
    function stop() {
      stopTimer();
      removeCaret();
      onTyped = null;
    }

    function reset() {
      stop();
      hideLate();
      status = 'idle';
      if (root) root.removeAttribute('data-msg');
      for (var i = 0; i < chars.length; i++) {
        chars[i].el.classList.remove('msg-on');
        chars[i].el.classList.remove('msg-wiggle');
      }
    }

    build();

    Card.message = {reveal: reveal, showLate: showLate, hideLate: hideLate, stop: stop, reset: reset};

  } catch (err) {console.error('[message] failed to load:', err);}
})();
