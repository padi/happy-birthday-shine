; (function () {
  'use strict';
  try {
    /* popup.js - the pop-up cake: performs the cake's beats of a Round (src/round.js owns when).
       Implements Card.cake = { rise(rm), light(i), lightAll(), fizzle(i), flicker(strength), blowOut(),
       relight(rm), fold(), reset() }. Each beat acts now; the only timers here are local animation detail
       (the 110 ms relight stagger, clearing a finished fizzle). Candle tapping / blow detection is NOT here
       (finale.js attaches to #candles). */
    var Card = window.Card;
    var root = document.getElementById('popup');
    var candlesEl = document.getElementById('candles');
    var candleEls = root ? Array.prototype.slice.call(root.querySelectorAll('.candle')) : [];

    var timers = [];
    var out = false;        // true after blowOut() until relight()/reset
    var strength = 0;

    function later(fn, ms) {
      var id = setTimeout(function () {
        var i = timers.indexOf(id);
        if (i >= 0) timers.splice(i, 1);
        fn();
      }, ms);
      timers.push(id);
    }
    function clearTimers() {
      while (timers.length) clearTimeout(timers.pop());
    }
    // remove + re-add a class so its CSS animation restarts
    function retrigger(el, cls) {
      el.classList.remove(cls);
      void el.getBoundingClientRect();
      el.classList.add(cls);
    }

    function setFlicker(s) {
      s = Number(s);
      if (!isFinite(s)) s = 0;
      s = s < 0 ? 0 : (s > 1 ? 1 : s);
      strength = s;
      if (!root) return;
      root.style.setProperty('--bend', (s * 55).toFixed(2));
      root.style.setProperty('--shrink', s.toFixed(3));
    }

    function lightCandle(c) {
      if (!c) return;
      c.classList.remove('out', 'fizz');
      c.classList.add('on');
    }
    function fizzle(c) {
      if (!c) return;
      c.classList.remove('on', 'out');
      retrigger(c, 'fizz');
      later(function () {c.classList.remove('fizz');}, 1100);
    }

    function resetState() {
      clearTimers();
      out = false;
      if (!root) return;
      setFlicker(0);
      candleEls.forEach(function (c) {c.classList.remove('on', 'out', 'fizz');});
      root.classList.remove('is-up', 'is-folding', 'rm');
      void root.getBoundingClientRect();   // so a replayed open restarts every animation
    }

    var cake = {
      // spring up (~2.65s in total: tiers 0-0.96s, lean 0.82-1.72s, then the Round lights the candles).
      // false when there is no cake to show.
      rise: function (rm) {
        resetState();
        if (!root) return false;
        if (rm) root.classList.add('rm');   // appear quickly: no bounce
        root.classList.add('is-up');
        return true;
      },
      light: function (i) {lightCandle(candleEls[i]);},
      lightAll: function () {candleEls.forEach(lightCandle);},
      fizzle: function (i) {fizzle(candleEls[i]);},   // spark + tiny smoke, flame dies

      // 0..1: flames lean and shrink in proportion to strength
      flicker: function (s) {setFlicker(s);},

      // all flames go out with smoke wisps. Idempotent.
      blowOut: function () {
        if (out) return;
        out = true;
        clearTimers();            // cancel any local animation still scheduled
        setFlicker(0);
        candleEls.forEach(function (c) {
          var wasLit = c.classList.contains('on');
          c.classList.remove('on', 'fizz');
          if (wasLit) retrigger(c, 'out');
        });
      },

      // flames back (staggered unless reduced motion), smoke cleared
      relight: function (rm) {
        clearTimers();
        out = false;
        setFlicker(0);
        if (rm === undefined) rm = Card && Card.reducedMotion;
        candleEls.forEach(function (c, i) {
          c.classList.remove('out', 'fizz');
          if (rm) lightCandle(c);
          else later(function () {lightCandle(c);}, i * 110);
        });
      },

      // the card is folding shut
      fold: function () {
        clearTimers();
        if (!root) return;
        setFlicker(0);
        candleEls.forEach(function (c) {c.classList.remove('on', 'out', 'fizz');});
        root.classList.remove('is-up');
        void root.getBoundingClientRect();
        root.classList.add('is-folding');
      },

      reset: resetState
    };
    if (Card) Card.cake = cake;

  } catch (err) {console.error('[popup] failed to load:', err);}
})();
