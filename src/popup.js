; (function () {
  'use strict';
  try {
    /* popup.js - pop-up cake: spring up on 'opened', light the candles (3rd one fizzles), emit 'popupDone'.
       Implements Card.cake = { flicker(strength), blowOut(), relight() }.
       Candle tapping / blow detection is NOT here (finale.js attaches to #candles). */
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
      c.classList.remove('out', 'fizz');
      c.classList.add('on');
    }
    function fizzle(c) {
      c.classList.remove('on', 'out');
      retrigger(c, 'fizz');
      later(function () {c.classList.remove('fizz');}, 1100);
    }

    var cake = {
      // 0..1: flames lean and shrink in proportion to strength
      flicker: function (s) {setFlicker(s);},

      // all flames go out with smoke wisps. Idempotent.
      blowOut: function () {
        if (out) return;
        out = true;
        clearTimers();            // cancel any lighting still scheduled
        setFlicker(0);
        candleEls.forEach(function (c) {
          var wasLit = c.classList.contains('on');
          c.classList.remove('on', 'fizz');
          if (wasLit) retrigger(c, 'out');
        });
      },

      // flames back (staggered), smoke cleared
      relight: function () {
        clearTimers();
        out = false;
        setFlicker(0);
        var rm = Card && Card.reducedMotion;
        candleEls.forEach(function (c, i) {
          c.classList.remove('out', 'fizz');
          if (rm) lightCandle(c);
          else later(function () {lightCandle(c);}, i * 110);
        });
      }
    };
    if (Card) Card.cake = cake;

    function resetState() {
      clearTimers();
      out = false;
      if (!root) return;
      setFlicker(0);
      candleEls.forEach(function (c) {c.classList.remove('on', 'out', 'fizz');});
      root.classList.remove('is-up', 'is-folding', 'rm');
      void root.getBoundingClientRect();   // so a replayed open restarts every animation
    }

    function rise() {
      resetState();
      if (!root) {Card.emit('popupDone'); return;}
      var rm = !!Card.reducedMotion;
      if (rm) root.classList.add('rm');
      root.classList.add('is-up');

      if (rm) {
        // appear quickly: no bounce, no fizzle
        later(function () {candleEls.forEach(lightCandle);}, 150);
        later(function () {Card.emit('popupDone');}, 350);
        return;
      }
      // ~2.65s in total: tiers 0-0.96s, lean 0.82-1.72s, candles after that
      later(function () {lightCandle(candleEls[0]);}, 1350);
      later(function () {lightCandle(candleEls[1]);}, 1600);
      later(function () {fizzle(candleEls[2]);}, 1850);   // spark + tiny smoke, flame dies
      later(function () {lightCandle(candleEls[2]);}, 2450);   // ...and catches ~0.6s later
      later(function () {Card.emit('popupDone');}, 2650);
    }

    function fold() {
      clearTimers();
      if (!root) return;
      setFlicker(0);
      candleEls.forEach(function (c) {c.classList.remove('on', 'out', 'fizz');});
      root.classList.remove('is-up');
      void root.getBoundingClientRect();
      root.classList.add('is-folding');
    }

    function replay() {
      cake.relight();
      later(function () {Card.emit('popupDone');}, Card.reducedMotion ? 60 : 450);
    }

    if (Card) {
      Card.on('opened', rise);
      Card.on('closing', fold);
      Card.on('closed', resetState);
      Card.on('replay', replay);
    }

  } catch (err) {console.error('[popup] failed to load:', err);}
})();
