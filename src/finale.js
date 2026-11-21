; (function () {
  'use strict';
  try {
    /* finale.js - T5: blow interaction (mic or taps), finale sequence, replay.
       After 'popupDone' it shows #blow-ui ("Make a wish & blow!" + mic / tap buttons).
       The candles go out exactly once per round (mic blow, 3 taps, or 1 tap with reduced motion), then:
       whoosh -> confetti + pop -> manatee slides in and munches -> Replay -> 'finaleDone'.
       Replay emits 'replay' (popup.js relights and re-emits popupDone). 'closing' / 'closed' reset everything.
       All DOM is created here (inside #blow-ui and #finale); styles live in finale.css. */
    var Card = window.Card;
    var CONFIG = window.CONFIG || {};
    var doc = document;

    var blowEl = doc.getElementById('blow-ui');
    var finaleEl = doc.getElementById('finale');
    var popupEl = doc.getElementById('popup');
    var candlesEl = doc.getElementById('candles');

    // ---------- tuning ----------
    var TAPS_NEEDED = 3;          // puffs to put the candles out (1 with reduced motion)
    var BAND_LO = 100, BAND_HI = 1000;   // Hz: the "whoosh" of a blow lives down here
    var BASELINE_MS = 300;        // ambient measurement window
    var DB_FLOOR = -85;           // never trust an ambient level below this (digital silence)
    var DB_START = 6, DB_SPAN = 18;      // strength = (dB over ambient - DB_START) / DB_SPAN
    var THRESHOLD = 0.4;          // strength that counts as "blowing"
    var NEED_MS = 400, WINDOW_MS = 1000; // cumulative over-threshold time inside a sliding window
    var HINT_MS = 10000;          // no blow yet -> hint
    var MIC_MAX_MS = 45000;       // never keep the mic open forever
    var T_CONFETTI = 500, T_MANATEE = 1200, MUNCH_GAP = 400;

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
    var armed = false;            // true between popupDone and candles out
    var outDone = false;          // the "exactly once per round" guard
    var mode = 'idle';            // idle | ask | requesting | listening | tap | out
    var micOk = true;             // false after a denial / error / missing support
    var taps = 0;
    var tapLevel = 0;             // flicker contributed by taps (decays)
    var micStrength = 0;
    var timers = [];
    var tapTimers = [];
    var micTimers = [];
    var mic = null;               // { ac, stream, src, an, raf, ... } while the mic is open
    var token = 0;                // invalidates late getUserMedia results

    var ui = {};                  // element refs

    function mk(tag, cls, text) {
      var e = doc.createElement(tag);
      if (cls) e.className = cls;
      if (text != null) e.textContent = text;
      return e;
    }
    function noop() { }
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
    function nowMs() {
      return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    }

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
        replay();
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
      if (!armed || outDone) return;
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
        extinguish();
        return;
      }
      var left = needed() - taps;
      if (mode === 'ask' || mode === 'tap') {
        if (mode === 'ask') {mode = 'tap'; render();}
        setText('Puff! ' + left + ' more 💨');
      }
    }

    function switchToTap(failed) {
      token++;                    // abandon any pending permission prompt
      stopMic();
      if (failed) micOk = false;
      if (!armed || outDone) return;
      mode = 'tap';
      render();
      setText(taps > 0 ? ('Puff! ' + (needed() - taps) + ' more 💨') : TXT.tap);
    }

    /* ====================================================================== mic path */
    function closeCtx(ac) {
      if (!ac) return;
      try {
        var p = ac.close();
        if (p && typeof p.catch === 'function') p.catch(noop);
      } catch (e) { /* ignore */}
    }
    function stopStream(stream) {
      if (!stream) return;
      try {
        var tracks = stream.getTracks ? stream.getTracks() : [];
        for (var i = 0; i < tracks.length; i++) {try {tracks[i].stop();} catch (e) { /* ignore */} }
      } catch (e2) { /* ignore */}
    }

    // stop all tracks, disconnect nodes, close the context. Safe to call any time.
    function stopMic() {
      clearList(micTimers);
      micStrength = 0;
      var m = mic;
      mic = null;
      if (!m) {setMeter(0); return;}
      if (m.raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(m.raf);
      m.raf = 0;
      stopStream(m.stream);
      try {if (m.src) m.src.disconnect();} catch (e) { /* ignore */}
      try {if (m.an) m.an.disconnect();} catch (e2) { /* ignore */}
      closeCtx(m.ac);
      setMeter(0);
    }

    function startMic() {
      if (!armed || outDone || mode === 'listening' || mode === 'requesting') return;
      var md = navigator.mediaDevices;
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!md || typeof md.getUserMedia !== 'function' || window.isSecureContext === false || !AC) {
        switchToTap(true);
        return;
      }
      // create the context inside the click (iOS / autoplay policies)
      var ac = null;
      try {
        ac = new AC();
        if (ac.state === 'suspended' && typeof ac.resume === 'function') {
          var rp = ac.resume();
          if (rp && typeof rp.catch === 'function') rp.catch(noop);
        }
      } catch (e) {ac = null;}
      if (!ac) {switchToTap(true); return;}

      var my = ++token;
      mode = 'requesting';
      render();
      setText(TXT.requesting);

      var req;
      try {
        req = Promise.resolve(md.getUserMedia({
          audio: {echoCancellation: false, noiseSuppression: false, autoGainControl: false}
        }));
      } catch (err) {
        closeCtx(ac);
        switchToTap(true);
        return;
      }
      req.then(function (stream) {
        if (my !== token || !armed || outDone) {   // card closed / tapped out / replaced while the prompt was open
          stopStream(stream);
          closeCtx(ac);
          return;
        }
        beginListening(ac, stream, my);
      }, function () {
        closeCtx(ac);
        if (my !== token) return;
        switchToTap(true);
      });
    }

    function beginListening(ac, stream, my) {
      var m = {ac: ac, stream: stream, src: null, an: null, raf: 0, buf: null, bytes: null};
      mic = m;
      try {
        m.src = ac.createMediaStreamSource(stream);
        m.an = ac.createAnalyser();
        m.an.fftSize = 2048;
        m.an.smoothingTimeConstant = 0.2;
        m.src.connect(m.an);                 // not connected to the speakers: no feedback
        m.buf = new Float32Array(m.an.frequencyBinCount);
        m.bytes = new Uint8Array(m.an.frequencyBinCount);
        if (ac.state === 'suspended' && typeof ac.resume === 'function') {
          var rp = ac.resume();
          if (rp && typeof rp.catch === 'function') rp.catch(noop);
        }
      } catch (e) {
        stopMic();
        switchToTap(true);
        return;
      }

      var binHz = ac.sampleRate / m.an.fftSize;
      var lo = Math.max(1, Math.floor(BAND_LO / binHz));
      var hi = Math.min(m.an.frequencyBinCount - 1, Math.ceil(BAND_HI / binHz));
      var t0 = nowMs();
      var last = t0;
      var baseSum = 0, baseN = 0, baseline = null;
      var samples = [];                      // { t, ms } of over-threshold time
      var smooth = 0;

      mode = 'listening';
      render();
      setText(TXT.baseline);
      setMeter(0);

      // 10s without a blow: hint (keeps listening)
      micTimers.push(setTimeout(function () {
        if (my !== token || mode !== 'listening') return;
        setText(TXT.hint);
      }, HINT_MS));
      // never leave the mic open for long
      micTimers.push(setTimeout(function () {
        if (my !== token || mode !== 'listening') return;
        switchToTap(false);
      }, MIC_MAX_MS));

      // band level in dB (mean power between BAND_LO and BAND_HI)
      function bandDb() {
        var an = m.an, sum = 0, n = hi - lo + 1, i;
        if (typeof an.getFloatFrequencyData === 'function') {
          an.getFloatFrequencyData(m.buf);
          for (i = lo; i <= hi; i++) {
            var d = m.buf[i];
            if (!isFinite(d)) d = -140;
            sum += Math.pow(10, d / 10);
          }
        } else {
          an.getByteFrequencyData(m.bytes);
          var mn = an.minDecibels, mx = an.maxDecibels;
          for (i = lo; i <= hi; i++) sum += Math.pow(10, (mn + (m.bytes[i] / 255) * (mx - mn)) / 10);
        }
        return 10 * Math.log10(sum / n + 1e-14);
      }

      function tick() {
        if (mic !== m) return;
        m.raf = requestAnimationFrame(tick);
        var t = nowMs();
        var dt = Math.min(100, Math.max(0, t - last));
        last = t;
        var db = bandDb();

        var strength = 0;
        if (baseline === null) {
          baseSum += db; baseN++;
          if (t - t0 >= BASELINE_MS && baseN > 0) {
            baseline = Math.max(DB_FLOOR, baseSum / baseN);
            setText(TXT.listening);
          }
        } else {
          var delta = db - baseline;
          strength = clamp01((delta - DB_START) / DB_SPAN);
          if (strength < 0.05) baseline = Math.max(DB_FLOOR, baseline * 0.98 + db * 0.02);   // follow slow drift
        }

        smooth = strength > smooth ? strength : smooth * 0.8 + strength * 0.2;   // quick attack, soft release
        micStrength = smooth;
        setMeter(smooth);
        applyFlicker();
        Card.emit('blow', {strength: smooth});

        samples.push({t: t, ms: strength >= THRESHOLD ? dt : 0});
        while (samples.length && t - samples[0].t > WINDOW_MS) samples.shift();
        var over = 0;
        for (var i = 0; i < samples.length; i++) over += samples[i].ms;
        if (over >= NEED_MS) extinguish();
      }
      m.raf = requestAnimationFrame(tick);
    }

    /* ====================================================================== candles out + finale */
    function extinguish() {
      if (outDone || !armed) return;
      outDone = true;
      armed = false;
      stopMic();                               // always: tracks stopped, nodes disconnected
      clearList(tapTimers);
      tapLevel = 0;
      mode = 'out';
      if (blowEl) blowEl.hidden = true;
      setText(TXT.out);

      if (Card.cake && Card.cake.blowOut) Card.cake.blowOut();
      if (Card.audio && Card.audio.whoosh) Card.audio.whoosh();
      Card.emit('candlesOut');

      later(function () {
        if (typeof Card.confetti === 'function') {
          var host = (popupEl && popupEl.querySelector('.cake-svg')) || popupEl || blowEl;
          var r = host.getBoundingClientRect();
          Card.confetti(r.left + r.width / 2, r.top + r.height * 0.55);
        }
        if (Card.audio && Card.audio.pop) Card.audio.pop();
      }, T_CONFETTI);

      later(manateeIn, T_MANATEE);
    }

    function manateeIn() {
      if (!ui.manatee) return;
      var rm = reduced();
      ui.manatee.classList.remove('is-in', 'is-munching');
      void ui.manatee.offsetWidth;
      ui.manatee.classList.add(rm ? 'is-fade' : 'is-slide');
      ui.manatee.classList.add('is-in');

      var slide = rm ? 450 : 800;
      var munchAt = slide - 50;
      for (var i = 0; i < 3; i++) {
        (function (k) {
          later(function () {
            if (k === 0) ui.manatee.classList.add('is-munching');
            if (Card.audio && Card.audio.munch) Card.audio.munch();
          }, munchAt + k * MUNCH_GAP);
        })(i);
      }
      later(finaleReady, munchAt + 2 * MUNCH_GAP + 550);
    }

    function finaleReady() {
      if (!ui.replay) return;
      ui.replay.classList.add('is-on');
      // keep keyboard users oriented: the focused blow button has just disappeared
      var a = doc.activeElement;
      if (!a || a === doc.body || (blowEl && blowEl.contains(a)) || (candlesEl && candlesEl.contains(a))) {
        try {ui.replay.focus({preventScroll: true});} catch (e) { /* ignore */}
      }
      Card.emit('finaleDone');
    }

    /* ====================================================================== rounds */
    function resetUi() {
      token++;
      stopMic();
      clearList(timers);
      clearList(tapTimers);
      armed = false;
      outDone = false;
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

    function showBlowUi() {
      if (!blowEl || !ui.text) return;
      if (Card.state !== 'open') return;
      resetUi();
      armed = true;
      mode = 'ask';
      render();
      setText(TXT.ask);
      blowEl.hidden = false;
      blowEl.classList.remove('is-in');
      void blowEl.offsetWidth;                // restart the entrance animation
      blowEl.classList.add('is-in');
    }

    function replay() {
      // hides the finale, resets the blow UI, then popup.js relights and re-emits 'popupDone'
      var focusWasIn = !!(ui.replay && doc.activeElement === ui.replay);
      resetUi();
      Card.emit('replay');
      if (focusWasIn && candlesEl) {try {candlesEl.focus({preventScroll: true});} catch (e) { /* ignore */} }
    }

    if (build()) {
      resetUi();
      Card.on('popupDone', showBlowUi);
      Card.on('replay', function () {if (mode !== 'idle' || outDone || armed) resetUi();});
      Card.on('closing', resetUi);
      Card.on('closed', resetUi);
      // a hidden tab must not keep the mic open
      doc.addEventListener('visibilitychange', function () {
        if (doc.hidden && (mode === 'listening' || mode === 'requesting')) {
          token++;
          stopMic();
          mode = 'ask';
          render();
          setText(TXT.ask, false);
        }
      });
    }

  } catch (err) {console.error('[finale] failed to load:', err);}
})();
