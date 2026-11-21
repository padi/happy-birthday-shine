; (function () {
  'use strict';
  try {
    /* core.js - CONFIG, Card event bus, open/close state machine.
       Contract (see PLAN.md "Shared contract"):
         window.CONFIG, window.Card = { state, on, off, emit, open, close, reducedMotion }
       Events fired here: 'opening' (synchronously inside the user gesture), 'opened',
       'closing', 'closed'. Other modules fire popupDone / blow / candlesOut / finaleDone / replay. */

    window.CONFIG = {to: 'Shine', from: 'Marc', date: 'November 19, 2026'};

    var CONFIG = window.CONFIG;
    var d = document;

    // ---------- element refs (all optional-safe) ----------
    var bodyEl = d.body;
    var cardEl = d.getElementById('card');
    var frontEl = d.getElementById('front');
    var insideEl = d.getElementById('inside');
    var closeBtn = d.getElementById('btn-close');

    // ---------- reduced motion ----------
    var mq = (typeof window.matchMedia === 'function') ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;

    function onMqChange() {
      Card.reducedMotion = !!(mq && mq.matches);
    }
    if (mq) {
      if (typeof mq.addEventListener === 'function') mq.addEventListener('change', onMqChange);
      else if (typeof mq.addListener === 'function') mq.addListener(onMqChange);
    }

    // ---------- event bus ----------
    var listeners = Object.create(null);

    function on(evt, fn) {
      if (typeof fn !== 'function') return function () { };
      (listeners[evt] || (listeners[evt] = [])).push(fn);
      return function () {off(evt, fn);};
    }

    function off(evt, fn) {
      var list = listeners[evt];
      if (!list) return;
      var i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    }

    // A throwing listener must never break the other listeners or the state machine.
    function emit(evt, data) {
      var list = listeners[evt];
      if (!list || !list.length) return;
      list = list.slice();
      for (var i = 0; i < list.length; i++) {
        try {
          list[i].call(Card, data, evt);
        } catch (err) {
          console.error('[Card] listener for "' + evt + '" threw:', err);
        }
      }
    }

    // ---------- timing ----------
    function cssMs(name, fallback) {
      try {
        var raw = String(window.getComputedStyle(d.documentElement).getPropertyValue(name) || '').trim();
        var n = parseFloat(raw);
        if (!isFinite(n) || n <= 0) return fallback;
        return /ms$/.test(raw) ? n : (/s$/.test(raw) ? n * 1000 : fallback);
      } catch (e) {
        return fallback;
      }
    }

    var FALLBACK_SLACK = 400; // extra ms after the CSS duration before we give up waiting for transitionend

    // ---------- state machine ----------
    var pending = null;   // 'opened' | 'closed' | null: the completion event we are waiting for
    var timer = null;
    var focusCloseOnOpened = false;
    var focusCoverOnClosed = false;

    function setInert(el, on_) {
      if (!el) return;
      if (on_) el.setAttribute('inert', '');
      else el.removeAttribute('inert');
    }

    function setState(s) {
      Card.state = s;
      if (bodyEl) bodyEl.setAttribute('data-state', s);
      if (cardEl) cardEl.setAttribute('data-state', s);
      setInert(insideEl, s === 'closed' || s === 'closing');
      setInert(frontEl, s !== 'closed');
      if (frontEl) frontEl.setAttribute('tabindex', s === 'closed' ? '0' : '-1');
      if (closeBtn) closeBtn.hidden = (s !== 'open');
    }

    function waitFor(kind) {
      pending = kind;
      if (timer) clearTimeout(timer);
      var ms;
      if (Card.reducedMotion) ms = cssMs('--fade-ms', 350);
      else ms = cssMs(kind === 'opened' ? '--open-ms' : '--close-ms', kind === 'opened' ? 1100 : 750);
      timer = setTimeout(settle, ms + FALLBACK_SLACK);
    }

    function settle() {
      if (!pending) return;
      var kind = pending;
      pending = null;
      if (timer) {clearTimeout(timer); timer = null;}
      if (kind === 'opened') {
        setState('open');
        Card.emit('opened');
      } else {
        setState('closed');
        Card.emit('closed');
      }
    }

    function open() {
      if (Card.state !== 'closed') return false;
      setState('opening');
      Card.emit('opening');     // synchronous: still inside the user gesture handler
      waitFor('opened');
      return true;
    }

    function close() {
      if (Card.state !== 'open') return false;
      focusCoverOnClosed = !!(closeBtn && d.activeElement === closeBtn);
      setState('closing');
      Card.emit('closing');
      waitFor('closed');
      return true;
    }

    var Card = window.Card = {
      state: 'closed',
      reducedMotion: !!(mq && mq.matches),
      on: on,
      off: off,
      emit: emit,
      open: open,
      close: close
    };

    // ---------- wiring ----------
    if (frontEl) {
      // completion of the cover animation (transition or animation), with the timer above as fallback
      frontEl.addEventListener('transitionend', function (e) {
        if (e.target !== frontEl || !pending) return;
        var want = Card.reducedMotion ? 'opacity' : 'transform';
        if (e.propertyName === want) settle();
      });
      frontEl.addEventListener('animationend', function (e) {
        if (e.target !== frontEl || !pending) return;
        if (/^card-(open|close)/.test(e.animationName || '')) settle();
      });

      // only the cover opens the card (tap / click / Enter / Space)
      frontEl.addEventListener('click', function () {
        Card.open();
      });
      frontEl.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
        if (e.repeat) return;
        e.preventDefault();
        focusCloseOnOpened = true;
        Card.open();
      });
    }

    if (closeBtn) {
      closeBtn.addEventListener('click', function () {
        Card.close();
      });
    }

    // Escape closes an open card; clicks inside the card never do
    d.addEventListener('keydown', function (e) {
      if ((e.key === 'Escape' || e.key === 'Esc') && Card.state === 'open') Card.close();
    });

    Card.on('opened', function () {
      if (focusCloseOnOpened && closeBtn) closeBtn.focus({preventScroll: true});
      focusCloseOnOpened = false;
    });
    Card.on('closed', function () {
      if (focusCoverOnClosed && frontEl) frontEl.focus({preventScroll: true});
      focusCoverOnClosed = false;
    });

    // personalise from CONFIG
    d.title = 'Happy Birthday, ' + CONFIG.to + '!';
    if (frontEl) frontEl.setAttribute('aria-label', 'Open ' + CONFIG.to + '’s birthday card');

    setState('closed');

  } catch (err) {console.error('[core] failed to load:', err);}
})();
