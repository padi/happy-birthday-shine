; (function () {
  'use strict';
  try {
    /* audio.js - T4: Web Audio sounds + mute toggle.
       Card.audio = { kazoo(), whoosh(), pop(), munch(), stopAll(), muted (getter), toggleMute() }
       - No AudioContext exists until the 'opening' event (fired synchronously in the user gesture)
         or until a sound is requested. Everything is synthesised: no files, no URLs. */
    (function () {
      'use strict';

      var Card = window.Card;
      if (!Card) return;

      var MUTE_KEY = 'bday-muted';
      var MASTER_LEVEL = 0.65;

      var ctx = null;        // AudioContext (created lazily, never at load)
      var master = null;     // mute gain -> compressor -> destination
      var bus = null;        // current sound bus (replaced by stopAll)
      var noiseBuf = null;
      var active = [];       // currently scheduled/playing sources
      var muted = readMuted();

      // ---------- persistence ----------
      function readMuted() {
        try {return window.localStorage.getItem(MUTE_KEY) === '1';} catch (e) {return false;}
      }
      function writeMuted(v) {
        try {window.localStorage.setItem(MUTE_KEY, v ? '1' : '0');} catch (e) { /* private mode etc. */}
      }

      // ---------- context ----------
      function ensureCtx() {
        if (!ctx) {
          var AC = window.AudioContext || window.webkitAudioContext;
          if (!AC) return null;
          try {ctx = new AC({latencyHint: 'interactive'});}
          catch (e) {
            try {ctx = new AC();} catch (e2) {ctx = null; return null;}
          }
          try {
            master = ctx.createGain();
            master.gain.value = muted ? 0 : MASTER_LEVEL;
            var comp = ctx.createDynamicsCompressor();
            comp.threshold.value = -20;
            comp.knee.value = 12;
            comp.ratio.value = 6;
            comp.attack.value = 0.004;
            comp.release.value = 0.2;
            master.connect(comp);
            comp.connect(ctx.destination);
          } catch (e3) {ctx = null; master = null; return null;}
        }
        if (ctx.state === 'suspended' || ctx.state === 'interrupted') {
          try {
            var p = ctx.resume();
            if (p && typeof p.catch === 'function') p.catch(function () { });
          } catch (e4) { /* ignore */}
        }
        return ctx;
      }

      function getBus() {
        if (!bus) {
          bus = ctx.createGain();
          bus.gain.value = 1;
          bus.connect(master);
        }
        return bus;
      }

      // iOS: a one-sample silent buffer started inside the gesture fully unlocks output.
      function unlock() {
        try {
          var b = ctx.createBuffer(1, 1, 22050);
          var s = ctx.createBufferSource();
          s.buffer = b;
          s.connect(ctx.destination);
          s.start(0);
        } catch (e) { /* ignore */}
      }

      function track(src) {
        active.push(src);
        src.onended = function () {
          var i = active.indexOf(src);
          if (i >= 0) active.splice(i, 1);
          try {src.disconnect();} catch (e) { /* ignore */}
        };
        return src;
      }

      function getNoise() {
        if (!noiseBuf) {
          var len = Math.floor(ctx.sampleRate * 1.5);
          noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
          var data = noiseBuf.getChannelData(0);
          for (var i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
        }
        return noiseBuf;
      }

      function noiseSource(t, dur) {
        var s = track(ctx.createBufferSource());
        s.buffer = getNoise();
        s.start(t, Math.random() * 0.4);
        s.stop(t + dur);
        return s;
      }

      function osc(type, t0, t1) {
        var o = track(ctx.createOscillator());
        o.type = type;
        o.start(t0);
        o.stop(t1);
        return o;
      }

      function midi(m) {return 440 * Math.pow(2, (m - 69) / 12);}

      // ---------- kazoo: Happy Birthday (public domain), 3/4 in C ----------
      var BEAT = 0.43; // seconds per quarter note (~140 bpm); whole tune is ~11 s
      var G4 = 67, A4 = 69, B4 = 71, C5 = 72, D5 = 74, E5 = 76, F5 = 77, G5 = 79;
      var MELODY = [
        // "Hap-py birth-day to you"      (pickup pair = dotted eighth + sixteenth)
        [G4, 0.75], [G4, 0.25], [A4, 1], [G4, 1], [C5, 1], [B4, 2],
        // "Hap-py birth-day to you"
        [G4, 0.75], [G4, 0.25], [A4, 1], [G4, 1], [D5, 1], [C5, 2],
        // "Hap-py birth-day dear Shine"
        [G4, 0.75], [G4, 0.25], [G5, 1], [E5, 1], [C5, 1], [B4, 1], [A4, 2],
        // "Hap-py birth-day to you"
        [F5, 0.75], [F5, 0.25], [E5, 1], [C5, 1], [D5, 1], [C5, 2.5]
      ];

      var shaperCurve = null;
      function getShaperCurve() {
        if (!shaperCurve) {
          var n = 257;
          shaperCurve = new Float32Array(n);
          for (var i = 0; i < n; i++) {
            var x = (i / (n - 1)) * 2 - 1;
            // slightly asymmetric soft clip = reedy buzz
            shaperCurve[i] = Math.tanh(2.4 * x + 0.3) - Math.tanh(0.3);
          }
        }
        return shaperCurve;
      }

      // shared kazoo voice chain: saws -> buzz shaper -> parallel formant bandpasses -> out
      function buildKazooChain(out) {
        var inp = ctx.createGain();
        inp.gain.value = 1;

        var shaper = ctx.createWaveShaper();
        shaper.curve = getShaperCurve();
        try {shaper.oversample = '2x';} catch (e) { /* ignore */}
        inp.connect(shaper);

        var sum = ctx.createGain();
        sum.gain.value = 0.9;

        // formants (nasal, tin-can resonances) around 1-2.5 kHz
        var formants = [[950, 3.5, 0.9], [1650, 6, 1.25], [2450, 7, 0.8]];
        for (var i = 0; i < formants.length; i++) {
          var bp = ctx.createBiquadFilter();
          bp.type = 'bandpass';
          bp.frequency.value = formants[i][0];
          bp.Q.value = formants[i][1];
          var g = ctx.createGain();
          g.gain.value = formants[i][2];
          shaper.connect(bp);
          bp.connect(g);
          g.connect(sum);
        }

        // a little body so low notes do not vanish
        var hp = ctx.createBiquadFilter();
        hp.type = 'highpass';
        hp.frequency.value = 320;
        var body = ctx.createGain();
        body.gain.value = 0.18;
        shaper.connect(hp);
        hp.connect(body);
        body.connect(sum);

        // presence peak
        var peak = ctx.createBiquadFilter();
        peak.type = 'peaking';
        peak.frequency.value = 1800;
        peak.Q.value = 1.2;
        peak.gain.value = 4;
        sum.connect(peak);

        var outGain = ctx.createGain();
        outGain.gain.value = 0.6;
        peak.connect(outGain);
        outGain.connect(out);
        return inp;
      }

      function kazooNote(dest, m, t, dur, isLast) {
        var f = midi(m);
        var end = t + dur;

        var env = ctx.createGain();
        env.connect(dest);
        var atk = Math.min(0.022, dur * 0.3);
        var rel = isLast ? 0.16 : Math.min(0.05, dur * 0.3);
        var peak = 0.34;
        env.gain.setValueAtTime(0, t);
        env.gain.linearRampToValueAtTime(peak, t + atk);
        env.gain.linearRampToValueAtTime(peak * 0.82, Math.max(t + atk + 0.001, end - rel));
        env.gain.linearRampToValueAtTime(0, end);

        // vibrato: ~6 Hz LFO in cents, delayed onset
        var lfo = osc('sine', t, end + 0.02);
        lfo.frequency.value = 6;
        var lfoGain = ctx.createGain();
        lfoGain.gain.setValueAtTime(0, t);
        lfoGain.gain.setValueAtTime(0, t + 0.13);
        lfoGain.gain.linearRampToValueAtTime(isLast ? 30 : 20, t + 0.3);
        lfo.connect(lfoGain);

        var scoopDur = Math.min(0.07, dur * 0.4);
        var detunes = [7, -7]; // two slightly detuned saws
        for (var i = 0; i < detunes.length; i++) {
          var o = osc('sawtooth', t, end + 0.02);
          o.detune.value = detunes[i];
          o.frequency.setValueAtTime(f * 0.945, t);                 // small scoop up into the pitch
          o.frequency.exponentialRampToValueAtTime(f, t + scoopDur);
          lfoGain.connect(o.detune);
          o.connect(env);
        }
      }

      function kazoo(delay) {
        if (!ensureCtx()) return;
        var t = ctx.currentTime + 0.03 + (typeof delay === 'number' && delay > 0 ? delay : 0);
        var chain = buildKazooChain(getBus());
        var pos = 0;
        for (var i = 0; i < MELODY.length; i++) {
          var m = MELODY[i][0], beats = MELODY[i][1];
          var isLast = i === MELODY.length - 1;
          var gap = beats >= 2 ? 0.06 : (beats < 0.5 ? 0.02 : 0.035);
          var dur = Math.max(0.05, beats * BEAT - gap);
          kazooNote(chain, m, t + pos * BEAT, dur, isLast);
          pos += beats;
        }
      }

      // ---------- whoosh: filtered noise sweep ~0.6 s ----------
      function whoosh() {
        if (!ensureCtx()) return;
        var t = ctx.currentTime + 0.02;
        var dur = 0.7;
        var src = noiseSource(t, dur);
        var bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.Q.value = 1.4;
        bp.frequency.setValueAtTime(350, t);
        bp.frequency.exponentialRampToValueAtTime(3200, t + 0.28);
        bp.frequency.exponentialRampToValueAtTime(800, t + 0.65);
        var g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.7, t + 0.2);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.65);
        src.connect(bp);
        bp.connect(g);
        g.connect(getBus());
      }

      // ---------- pop: sine pitch drop + noise click ----------
      function pop() {
        if (!ensureCtx()) return;
        var t = ctx.currentTime + 0.01;
        var b = getBus();

        var o = osc('sine', t, t + 0.2);
        o.frequency.setValueAtTime(520, t);
        o.frequency.exponentialRampToValueAtTime(70, t + 0.12);
        var g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.9, t + 0.006);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.15);
        o.connect(g);
        g.connect(b);

        var n = noiseSource(t, 0.04);
        var hp = ctx.createBiquadFilter();
        hp.type = 'highpass';
        hp.frequency.value = 1500;
        var ng = ctx.createGain();
        ng.gain.setValueAtTime(0.5, t);
        ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.03);
        n.connect(hp);
        hp.connect(ng);
        ng.connect(b);
      }

      // ---------- munch: 3 quick crunchy bites ----------
      function munch() {
        if (!ensureCtx()) return;
        var t0 = ctx.currentTime + 0.02;
        var b = getBus();
        var offsets = [0, 0.2, 0.4];
        var pitch = [1, 0.82, 0.93];
        for (var i = 0; i < 3; i++) {
          var t = t0 + offsets[i];
          var p = pitch[i];

          // crunch: three tiny noise grains through a falling bandpass
          var n = noiseSource(t, 0.14);
          var bp = ctx.createBiquadFilter();
          bp.type = 'bandpass';
          bp.Q.value = 2.2;
          bp.frequency.setValueAtTime(1500 * p, t);
          bp.frequency.exponentialRampToValueAtTime(450 * p, t + 0.12);
          var g = ctx.createGain();
          g.gain.setValueAtTime(0.0001, t);
          var grains = [0, 0.03, 0.065];
          for (var k = 0; k < grains.length; k++) {
            var gt = t + grains[k];
            var amp = k === 0 ? 0.9 : 0.6;
            g.gain.setValueAtTime(0.0001, gt);
            g.gain.exponentialRampToValueAtTime(amp, gt + 0.004);
            g.gain.exponentialRampToValueAtTime(0.0001, gt + 0.03);
          }
          n.connect(bp);
          bp.connect(g);
          g.connect(b);

          // "nom": soft low thump with a pitch drop
          var o = osc('sine', t, t + 0.12);
          o.frequency.setValueAtTime(230 * p, t);
          o.frequency.exponentialRampToValueAtTime(120 * p, t + 0.1);
          var og = ctx.createGain();
          og.gain.setValueAtTime(0.0001, t);
          og.gain.exponentialRampToValueAtTime(0.5, t + 0.012);
          og.gain.exponentialRampToValueAtTime(0.0001, t + 0.11);
          o.connect(og);
          og.connect(b);
        }
      }

      // ---------- stopAll: quick fade, then stop + disconnect everything ----------
      function stopAll() {
        if (!ctx) return;
        var now = ctx.currentTime;
        var oldBus = bus;
        var list = active.slice();
        bus = null; // next sound builds a fresh bus
        if (oldBus) {
          try {
            oldBus.gain.cancelScheduledValues(now);
            oldBus.gain.setTargetAtTime(0, now, 0.015);
          } catch (e) { /* ignore */}
        }
        for (var i = 0; i < list.length; i++) {
          try {list[i].stop(now + 0.07);} catch (e) { /* not started / already stopped */}
        }
        active = [];
        setTimeout(function () {
          for (var j = 0; j < list.length; j++) {
            try {list[j].disconnect();} catch (e) { /* ignore */}
          }
          if (oldBus) {try {oldBus.disconnect();} catch (e) { /* ignore */} }
        }, 250);
      }

      // ---------- mute ----------
      var btn = null;

      function applyMute() {
        if (ctx && master) {
          try {
            var now = ctx.currentTime;
            master.gain.cancelScheduledValues(now);
            master.gain.setTargetAtTime(muted ? 0 : MASTER_LEVEL, now, 0.03);
          } catch (e) {master.gain.value = muted ? 0 : MASTER_LEVEL;}
        }
        if (btn) {
          btn.setAttribute('aria-pressed', muted ? 'true' : 'false');
          btn.setAttribute('aria-label', muted ? 'Unmute sound' : 'Mute sound');
          btn.title = muted ? 'Unmute sound' : 'Mute sound';
          var icon = btn.firstChild;
          if (icon) icon.textContent = muted ? '🔇' : '🔊'; // muted speaker / speaker
        }
      }

      function setMuted(v) {
        muted = !!v;
        writeMuted(muted);
        applyMute();
        if (ctx && !muted) ensureCtx(); // inside the click gesture: make sure output is running
      }

      function toggleMute() {
        setMuted(!muted);
        return muted;
      }

      function buildButton() {
        var controls = document.getElementById('controls');
        if (!controls) return;
        btn = document.createElement('button');
        btn.type = 'button';
        btn.id = 'btn-mute';
        btn.className = 'ctl-btn';
        var icon = document.createElement('span');
        icon.setAttribute('aria-hidden', 'true');
        btn.appendChild(icon);
        btn.addEventListener('click', function (e) {
          e.stopPropagation();
          toggleMute();
        });
        controls.appendChild(btn);
        applyMute();
      }

      // ---------- wiring ----------
      Card.on('opening', function () {
        // synchronous inside the user gesture: create/resume the context here
        if (!ensureCtx()) return;
        unlock();
        kazoo(0.4);
      });
      Card.on('closing', stopAll);

      Card.audio = {
        kazoo: function () {kazoo(0);},
        whoosh: whoosh,
        pop: pop,
        munch: munch,
        stopAll: stopAll,
        get muted() {return muted;},
        toggleMute: toggleMute
      };

      buildButton();
    })();

  } catch (err) {console.error('[audio] failed to load:', err);}
})();
