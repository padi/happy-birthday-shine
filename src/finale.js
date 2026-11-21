; (function () {
  'use strict';
  try {
    /* finale.js - blow interaction (mic or taps) and the finale's beats of a Round (src/round.js owns when).
       Exposes Card.finale = { showBlowUi(onBlown), candlesOut(), celebrate(), manateeIn(rm), munch(k),
       replayReady(onReplay), reset() }.
       showBlowUi shows #blow-ui ("Make a wish & blow!" + mic / tap buttons); a mic blow, 3 taps (1 with
       reduced motion) call onBlown - the Round makes sure the candles go out exactly once per Round.
       The Replay button calls onReplay. Local timers only: tap flicker decay, the live-region nudge.
       All DOM is created here (inside #blow-ui and #finale); styles live in card.css. */
    var Card = window.Card;
    var CONFIG = window.CONFIG || {};
    var doc = document;

    var blowEl = doc.getElementById('blow-ui');
    var finaleEl = doc.getElementById('finale');
    var popupEl = doc.getElementById('popup');
    var candlesEl = doc.getElementById('candles');

    // ---------- tuning ----------
    var TAPS_NEEDED = 3;          // puffs to put the candles out (1 with reduced motion)
    // mic tuning (baseline, threshold, window, hint / max-open timers) lives in blow-detector.js

    var TXT = {
      ask: 'Make a wish & blow! 🎂',
      requesting: 'Waiting for the mic…',
      baseline: 'Listening… get ready 🌬️',
      listening: 'Listening… blow on the mic! 🌬️',
      hint: 'Blow closer to the mic — or tap the candles!',
      tap: 'Tap the candles to blow them out 🕯️',
      out: 'The candles are out! 🎉'
    };

    // ---------- state ----------
    var armed = false;            // true between showBlowUi and candles out: taps / mic count
    var mode = 'idle';            // idle | ask | requesting | listening | tap | out
    var micOk = true;             // false after a denial / error / missing support
    var taps = 0;
    var tapLevel = 0;             // flicker contributed by taps (decays)
    var micStrength = 0;
    var timers = [];
    var tapTimers = [];
    var mic = null;               // Card.blowDetector session handle { stop() } while the mic is open
    var onBlown = null;           // the Round's callbacks for this round
    var onReplay = null;

    var ui = {};                  // element refs

    function mk(tag, cls, text) {
      var e = doc.createElement(tag);
      if (cls) e.className = cls;
      if (text != null) e.textContent = text;
      return e;
    }
    function later(fn, ms) {
      var id = setTimeout(function () {
        var i = timers.indexOf(id);
        if (i >= 0) timers.splice(i, 1);
        fn();
      }, ms);
      timers.push(id);
      return id;
    }
    function clearList(list) {while (list.length) clearTimeout(list.pop());}
    function reduced() {return !!Card.reducedMotion;}
    function clamp01(v) {return v < 0 ? 0 : (v > 1 ? 1 : v);}

    /* ====================================================================== DOM */
    function build() {
      if (!blowEl || !finaleEl) return false;

      // --- blow UI: prompt + meter on one row, two buttons below (kept short: ~66px) ---
      blowEl.textContent = '';
      var row = mk('div', 'bu-row');
      ui.text = mk('span', 'bu-text');
      ui.text.setAttribute('aria-hidden', 'true');   // spoken through the live region instead
      ui.meter = mk('span', 'bu-meter');
      ui.meter.setAttribute('aria-hidden', 'true');
      ui.meterFill = mk('i');
      ui.meter.appendChild(ui.meterFill);
      row.appendChild(ui.text);

      var btns = mk('div', 'bu-btns');
      ui.micBtn = mk('button', 'bu-btn bu-mic');
      ui.micBtn.type = 'button';
      ui.tapBtn = mk('button', 'bu-btn bu-tap');
      ui.tapBtn.type = 'button';
      ui.micLabel = mk('span', 'bu-label');
      ui.micBtn.appendChild(ui.micLabel);
      ui.micBtn.appendChild(ui.meter);        // live level bar along the bottom edge of the mic button
      btns.appendChild(ui.micBtn);
      btns.appendChild(ui.tapBtn);
      blowEl.appendChild(row);
      blowEl.appendChild(btns);
      blowEl.setAttribute('role', 'group');
      blowEl.setAttribute('aria-label', 'Blow out the candles');

      // --- finale layer: live region, manatee, replay ---
      finaleEl.textContent = '';
      ui.live = mk('p', 'fn-live sr-only');
      ui.live.setAttribute('role', 'status');
      ui.live.setAttribute('aria-live', 'polite');
      ui.live.setAttribute('aria-atomic', 'true');

      ui.manatee = mk('div', 'fn-manatee');
      ui.manatee.setAttribute('aria-hidden', 'true');
      ui.art = mk('div', 'fn-art');
      var NS = 'http://www.w3.org/2000/svg';
      var svg = doc.createElementNS(NS, 'svg');
      svg.setAttribute('viewBox', '0 10 310 200');
      svg.setAttribute('focusable', 'false');
      var use = doc.createElementNS(NS, 'use');
      use.setAttribute('href', '#manatee-eat');
      svg.appendChild(use);
      ui.art.appendChild(svg);
      ui.manatee.appendChild(ui.art);

      ui.replay = mk('button', 'bu-btn fn-replay', 'Replay 🔁');
      ui.replay.type = 'button';

      finaleEl.appendChild(ui.live);
      finaleEl.appendChild(ui.manatee);
      finaleEl.appendChild(ui.replay);

      ui.micBtn.addEventListener('click', function (e) {e.stopPropagation(); startMic();});
      ui.tapBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        if (mode === 'tap') puff();
        else switchToTap(false);
      });
      ui.replay.addEventListener('click', function (e) {
        e.stopPropagation();
        // keep focus on the cake: the Replay button is about to hide
        var focusWasIn = doc.activeElement === ui.replay;
        var cb = onReplay;
        if (cb) cb();
        if (focusWasIn && candlesEl) {try {candlesEl.focus({preventScroll: true});} catch (e2) { /* ignore */} }
      });

      // tapping / clicking / keyboard on the candles
      if (candlesEl) {
        candlesEl.addEventListener('click', function () {puff();});
        candlesEl.addEventListener('keydown', function (e) {
          if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
          e.preventDefault();
          if (e.repeat) return;
          puff();
        });
      }
      return true;
    }

    function say(text) {          // screen-reader announcement (aria-live=polite)
      if (!ui.live) return;
      ui.live.textContent = '';
      later(function () {ui.live.textContent = text;}, 40);
    }

    function setText(t, announce) {
      if (ui.text) {
        ui.text.textContent = t;
        ui.text.classList.toggle('is-long', t.length > 38);
      }
      if (announce !== false) say(t);
    }

    function setMeter(v) {
      if (ui.meterFill) ui.meterFill.style.transform = 'scaleX(' + clamp01(v).toFixed(3) + ')';
    }

    function pressed(btn, on) {
      btn.setAttribute('aria-disabled', on ? 'true' : 'false');
      btn.classList.toggle('is-busy', !!on);
    }

    function render() {
      if (!ui.text) return;
      blowEl.setAttribute('data-mode', mode);
      ui.micBtn.hidden = !micOk;
      ui.meter.hidden = !(mode === 'listening' || mode === 'requesting');
      if (mode === 'listening' || mode === 'requesting') {
        ui.micLabel.textContent = mode === 'listening' ? '🎤 Listening…' : '🎤 Allow mic…';
        ui.micBtn.setAttribute('aria-label', mode === 'listening' ? 'Listening for a blow' : 'Waiting for microphone permission');
        pressed(ui.micBtn, true);
      } else {
        ui.micLabel.textContent = '🎤 Blow';
        ui.micBtn.setAttribute('aria-label', 'Blow into the microphone');
        pressed(ui.micBtn, false);
      }
      if (mode === 'tap') {
        ui.tapBtn.textContent = '💨 Puff';
        ui.tapBtn.setAttribute('aria-label', 'Puff at the candles');
      } else {
        ui.tapBtn.textContent = 'Tap instead';
        ui.tapBtn.setAttribute('aria-label', 'Tap the candles instead of blowing');
      }
    }

    /* ====================================================================== flicker helpers */
    function applyFlicker() {
      var c = Card.cake;
      if (c && typeof c.flicker === 'function') c.flicker(clamp01(Math.max(micStrength, tapLevel)));
    }

    /* ====================================================================== tap path */
    function needed() {return reduced() ? 1 : TAPS_NEEDED;}

    function puff() {
      if (!armed) return;
      taps++;
      clearList(tapTimers);
      tapLevel = 0.9;
      applyFlicker();
      // decay: 0.9 -> 0.55 -> 0.25 -> 0
      [[140, 0.55], [300, 0.25], [480, 0]].forEach(function (s) {
        var id = setTimeout(function () {
          var i = tapTimers.indexOf(id);
          if (i >= 0) tapTimers.splice(i, 1);
          tapLevel = s[1];
          applyFlicker();
        }, s[0]);
        tapTimers.push(id);
      });
      if (taps >= needed()) {
        blown();
        return;
      }
      var left = needed() - taps;
      if (mode === 'ask' || mode === 'tap') {
        if (mode === 'ask') {mode = 'tap'; render();}
        setText('Puff! ' + left + ' more 💨');
      }
    }

    function switchToTap(failed) {
      stopMic();                  // also abandons any pending permission prompt
      if (failed) micOk = false;
      if (!armed) return;
      mode = 'tap';
      render();
      setText(taps > 0 ? ('Puff! ' + (needed() - taps) + ' more 💨') : TXT.tap);
    }

    /* ====================================================================== mic path */
    // the detector owns the mic session; this side only maps its statuses onto the blow UI
    function stopMic() {          // safe to call any time
      var h = mic;
      mic = null;
      if (h) h.stop();
      micStrength = 0;
      setMeter(0);
    }

    function startMic() {
      if (!armed || mode === 'listening' || mode === 'requesting') return;
      var det = Card.blowDetector;
      if (!det || typeof det.listen !== 'function') {switchToTap(true); return;}
      mic = det.listen({
        onStatus: function (s) {
          if (s === 'requesting') {
            mode = 'requesting';
            render();
            setText(TXT.requesting);
          } else if (s === 'baseline') {
            mode = 'listening';
            render();
            setText(TXT.baseline);
            setMeter(0);
          } else if (s === 'listening') {
            setText(TXT.listening);
          } else if (s === 'hint') {
            if (mode === 'listening') setText(TXT.hint);
          }
        },
        onStrength: function (v) {
          micStrength = v;
          setMeter(v);
          applyFlicker();
          Card.emit('blow', {strength: v});
        },
        onBlow: function () {blown();},
        // denied / unsupported / error -> tap only; MIC_MAX timeout -> tap but keep the mic button
        onFail: function (reason) {switchToTap(reason !== 'timeout');}
      });
    }

    /* ====================================================================== beats */
    function blown() {
      if (!armed) return;
      var cb = onBlown;
      if (cb) cb();
    }

    // blow UI off, whoosh (the Round blows the cake out and emits 'candlesOut')
    function candlesOut() {
      armed = false;
      onBlown = null;
      stopMic();                               // always: tracks stopped, nodes disconnected
      clearList(tapTimers);
      tapLevel = 0;
      mode = 'out';
      if (blowEl) blowEl.hidden = true;
      setText(TXT.out);
      if (Card.audio && Card.audio.whoosh) Card.audio.whoosh();
    }

    // confetti from the cake + pop
    function celebrate() {
      if (typeof Card.confetti === 'function') {
        var host = (popupEl && popupEl.querySelector('.cake-svg')) || popupEl || blowEl;
        var r = host.getBoundingClientRect();
        Card.confetti(r.left + r.width / 2, r.top + r.height * 0.55);
      }
      if (Card.audio && Card.audio.pop) Card.audio.pop();
    }

    // slide (fade with reduced motion) in; the Round times the munches against the entrance
    function manateeIn(rm) {
      if (!ui.manatee) return;
      if (rm === undefined) rm = reduced();
      ui.manatee.classList.remove('is-in', 'is-munching');
      void ui.manatee.offsetWidth;
      ui.manatee.classList.add(rm ? 'is-fade' : 'is-slide');
      ui.manatee.classList.add('is-in');
    }

    function munch(k) {
      if (!ui.manatee) return;
      if (k === 0) ui.manatee.classList.add('is-munching');
      if (Card.audio && Card.audio.munch) Card.audio.munch();
    }

    function replayReady(cb) {
      if (!ui.replay) return;
      onReplay = cb || null;
      ui.replay.classList.add('is-on');
      // keep keyboard users oriented: the focused blow button has just disappeared
      var a = doc.activeElement;
      if (!a || a === doc.body || (blowEl && blowEl.contains(a)) || (candlesEl && candlesEl.contains(a))) {
        try {ui.replay.focus({preventScroll: true});} catch (e) { /* ignore */}
      }
    }

    function resetUi() {
      stopMic();
      clearList(timers);
      clearList(tapTimers);
      armed = false;
      onBlown = null;
      onReplay = null;
      taps = 0;
      tapLevel = 0;
      micStrength = 0;
      mode = 'idle';
      if (blowEl) blowEl.hidden = true;
      if (ui.manatee) ui.manatee.classList.remove('is-in', 'is-slide', 'is-fade', 'is-munching');
      if (ui.replay) ui.replay.classList.remove('is-on');
      if (ui.live) ui.live.textContent = '';
      if (ui.text) ui.text.textContent = '';
      setMeter(0);
    }

    function showBlowUi(cb) {
      if (!blowEl || !ui.text) return;
      resetUi();
      armed = true;
      onBlown = cb || null;
      mode = 'ask';
      render();
      setText(TXT.ask);
      blowEl.hidden = false;
      blowEl.classList.remove('is-in');
      void blowEl.offsetWidth;                // restart the entrance animation
      blowEl.classList.add('is-in');
    }

    if (build()) {
      resetUi();
      Card.finale = {
        showBlowUi: showBlowUi,
        candlesOut: candlesOut,
        celebrate: celebrate,
        manateeIn: manateeIn,
        munch: munch,
        replayReady: replayReady,
        reset: resetUi
      };
      // a hidden tab must not keep the mic open
      doc.addEventListener('visibilitychange', function () {
        if (doc.hidden && (mode === 'listening' || mode === 'requesting')) {
          stopMic();
          mode = 'ask';
          render();
          setText(TXT.ask, false);
        }
      });
    }

  } catch (err) {console.error('[finale] failed to load:', err);}
})();
