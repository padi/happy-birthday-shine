; (function () {
  'use strict';
  try {
    /* blow-detector.js - "is someone blowing on the mic?"
       Interface (window.Card.blowDetector in the browser, module.exports in Node):

         listen({ onStatus, onStrength, onBlow, onFail }, [opts]) -> { stop() }
           Must be called inside the user gesture (the capture AudioContext is created synchronously).
           onStatus('requesting')  permission prompt is open
           onStatus('baseline')    mic is live, measuring the room for BASELINE_MS
           onStatus('listening')   baseline known, blow now
           onStatus('hint')        HINT_MS without a blow (keeps listening)
           onStrength(s)           every frame, smoothed strength 0..1
           onBlow({strength})      a blow was recognised (once); the mic is already shut down
           onFail(reason)          'unsupported' | 'denied' | 'error' | 'timeout' (MIC_MAX_MS); mic shut down
           stop()                  idempotent; stops tracks, disconnects nodes, closes the capture
                                   context, releases the iOS audio session (contexts.releaseCapture),
                                   discards a late getUserMedia result. No callbacks fire after stop().
           opts.level              level adapter factory (ac, stream) -> { read() -> dB, close() }
                                   default: adapters.analyser (AnalyserNode band level)
           opts.env                platform overrides: mediaDevices, AudioContext, audioSession,
                                   contexts, isSecureContext, now, raf, caf, setTimeout, clearTimeout.
                                   `contexts` is the AudioContext lifecycle adapter from audio.js
                                   (contextFactory); by default it is built from env.AudioContext /
                                   env.audioSession, so tests can inject either a fake constructor
                                   or a whole fake factory.

         Context ownership: the detector gets its context from audio.js's factory (one place for the
         create / resume / interrupted / close quirks) but owns a separate *capture* context rather
         than borrowing the sound bus's output context. iOS Safari ties playback volume and routing
         to when a context was created relative to capture (WebKit 218012: a context created before
         capture stays quiet; 230902 / 326286: output moves to the earpiece; 282939: the session can
         stay play-and-record after tracks stop), and the documented fixes are device-dependent. A
         private capture context keeps the output context's latencyHint / sampleRate untouched and
         lets the detector close everything it opened. The analyser is never connected to a
         destination (no feedback).

         classifier([t0]) -> { push(db, nowMs) -> { strength, blown, phase } }
           The pure classification core used by listen(): ambient baseline over BASELINE_MS,
           slow drift follow, strength curve, quick-attack / soft-release smoothing, and
           >= NEED_MS over THRESHOLD inside a sliding WINDOW_MS. `blown` is true on exactly one frame.

         adapters.analyser, adapters.scripted(dbList), TUNING */

    var TUNING = {
      BAND_LO: 100, BAND_HI: 1000,  // Hz: the "whoosh" of a blow lives down here
      BASELINE_MS: 300,             // ambient measurement window
      DB_FLOOR: -85,                // never trust an ambient level below this (digital silence)
      DB_START: 6, DB_SPAN: 18,     // strength = (dB over ambient - DB_START) / DB_SPAN
      THRESHOLD: 0.4,               // strength that counts as "blowing"
      NEED_MS: 400, WINDOW_MS: 1000, // cumulative over-threshold time inside a sliding window
      HINT_MS: 10000,               // no blow yet -> hint
      MIC_MAX_MS: 45000             // never keep the mic open forever
    };

    function noop() { }
    function clamp01(v) {return v < 0 ? 0 : (v > 1 ? 1 : v);}

    function stopStream(stream) {
      if (!stream) return;
      try {
        var tracks = stream.getTracks ? stream.getTracks() : [];
        for (var i = 0; i < tracks.length; i++) {try {tracks[i].stop();} catch (e) { /* ignore */} }
      } catch (e2) { /* ignore */}
    }

    // the AudioContext lifecycle lives in audio.js; found on Card.audio in the browser, required in Node
    function contextFactoryImpl() {
      if (typeof window !== 'undefined' && window.Card && window.Card.audio && window.Card.audio.contextFactory) {
        return window.Card.audio.contextFactory;
      }
      if (typeof require === 'function') {
        try {return require('./audio.js').contextFactory;} catch (e) { /* not available */}
      }
      return null;
    }

    /* ====================================================================== classification core */
    function classifier(t0) {
      var T = TUNING;
      var start = (typeof t0 === 'number') ? t0 : null;
      var last = start;
      var baseSum = 0, baseN = 0, baseline = null;
      var samples = [];                      // { t, ms } of over-threshold time
      var smooth = 0;
      var done = false;

      function push(db, t) {
        if (start === null) start = last = t;
        var dt = Math.min(100, Math.max(0, t - last));
        last = t;

        var strength = 0;
        if (baseline === null) {
          baseSum += db; baseN++;
          if (t - start >= T.BASELINE_MS && baseN > 0) baseline = Math.max(T.DB_FLOOR, baseSum / baseN);
        } else {
          var delta = db - baseline;
          strength = clamp01((delta - T.DB_START) / T.DB_SPAN);
          if (strength < 0.05) baseline = Math.max(T.DB_FLOOR, baseline * 0.98 + db * 0.02);   // follow slow drift
        }

        smooth = strength > smooth ? strength : smooth * 0.8 + strength * 0.2;   // quick attack, soft release

        samples.push({t: t, ms: strength >= T.THRESHOLD ? dt : 0});
        while (samples.length && t - samples[0].t > T.WINDOW_MS) samples.shift();
        var over = 0;
        for (var i = 0; i < samples.length; i++) over += samples[i].ms;
        var blown = false;
        if (!done && over >= T.NEED_MS) {done = true; blown = true;}

        return {strength: smooth, blown: blown, phase: baseline === null ? 'baseline' : 'listening'};
      }
      return {push: push};
    }

    /* ====================================================================== level adapters */
    // production: band level in dB (mean power between BAND_LO and BAND_HI) from an AnalyserNode
    function analyserLevel(ac, stream) {
      var src = null, an = null;
      try {
        src = ac.createMediaStreamSource(stream);
        an = ac.createAnalyser();
        an.fftSize = 2048;
        an.smoothingTimeConstant = 0.2;
        src.connect(an);                     // not connected to the speakers: no feedback
        var buf = new Float32Array(an.frequencyBinCount);
        var bytes = new Uint8Array(an.frequencyBinCount);
      } catch (e) {
        disconnect();
        throw e;
      }
      function disconnect() {
        try {if (src) src.disconnect();} catch (e) { /* ignore */}
        try {if (an) an.disconnect();} catch (e2) { /* ignore */}
      }
      var binHz = ac.sampleRate / an.fftSize;
      var lo = Math.max(1, Math.floor(TUNING.BAND_LO / binHz));
      var hi = Math.min(an.frequencyBinCount - 1, Math.ceil(TUNING.BAND_HI / binHz));

      function read() {
        var sum = 0, n = hi - lo + 1, i;
        if (typeof an.getFloatFrequencyData === 'function') {
          an.getFloatFrequencyData(buf);
          for (i = lo; i <= hi; i++) {
            var d = buf[i];
            if (!isFinite(d)) d = -140;
            sum += Math.pow(10, d / 10);
          }
        } else {
          an.getByteFrequencyData(bytes);
          var mn = an.minDecibels, mx = an.maxDecibels;
          for (i = lo; i <= hi; i++) sum += Math.pow(10, (mn + (bytes[i] / 255) * (mx - mn)) / 10);
        }
        return 10 * Math.log10(sum / n + 1e-14);
      }
      return {read: read, close: disconnect};
    }

    // test / scripted: one dB value per frame; the last value repeats when the list runs out
    function scriptedLevel(dbs) {
      return function () {
        var i = 0;
        return {
          read: function () {
            var v = typeof dbs === 'function' ? dbs(i) : dbs[Math.min(i, dbs.length - 1)];
            i++;
            return v;
          },
          close: noop
        };
      };
    }

    /* ====================================================================== mic session */
    function defaultEnv() {
      var g = (typeof window !== 'undefined') ? window : (typeof globalThis !== 'undefined' ? globalThis : {});
      var nav = g.navigator || (typeof navigator !== 'undefined' ? navigator : null);
      return {
        mediaDevices: nav ? nav.mediaDevices : undefined,
        AudioContext: g.AudioContext || g.webkitAudioContext,
        audioSession: nav ? nav.audioSession : undefined,
        isSecureContext: g.isSecureContext,
        now: function () {
          return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        },
        raf: function (fn) {return requestAnimationFrame(fn);},
        caf: function (id) {if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(id);},
        setTimeout: function (fn, ms) {return setTimeout(fn, ms);},
        clearTimeout: function (id) {clearTimeout(id);}
      };
    }

    function listen(cb, opts) {
      cb = cb || {};
      opts = opts || {};
      var env = defaultEnv();
      if (opts.env) for (var k in opts.env) if (Object.prototype.hasOwnProperty.call(opts.env, k)) env[k] = opts.env[k];
      var makeLevel = opts.level || analyserLevel;
      var contexts = env.contexts;
      if (!contexts) {
        var factory = contextFactoryImpl();
        contexts = factory ? factory({AudioContext: env.AudioContext, audioSession: env.audioSession}) : null;
      }

      var alive = true, ac = null, stream = null, level = null, raf = 0, timers = [];
      var captured = false;                 // getUserMedia handed us a stream (the session switched)
      var handle = {stop: teardown};

      function fire(name, arg) {if (typeof cb[name] === 'function') cb[name](arg);}
      function fail(reason) {teardown(); fire('onFail', reason);}

      // stop all tracks, disconnect our nodes, close our capture context. Safe to call any time.
      function teardown() {
        if (!alive) return;
        alive = false;
        while (timers.length) env.clearTimeout(timers.pop());
        if (raf) env.caf(raf);
        raf = 0;
        stopStream(stream);
        if (level) level.close();
        if (contexts) contexts.close(ac);
        if (captured) releaseSession();
        stream = level = ac = null;
      }
      function releaseSession() {
        captured = false;
        try {contexts.releaseCapture();} catch (e) { /* ignore */}
      }

      var md = env.mediaDevices;
      if (!md || typeof md.getUserMedia !== 'function' || env.isSecureContext === false ||
        !contexts || !contexts.supported()) {
        fail('unsupported');
        return handle;
      }
      // create the capture context inside the click (iOS / autoplay policies)
      ac = contexts.create();
      if (!ac) {fail('unsupported'); return handle;}

      fire('onStatus', 'requesting');
      if (!alive) return handle;

      var req;
      try {
        req = Promise.resolve(md.getUserMedia({
          audio: {echoCancellation: false, noiseSuppression: false, autoGainControl: false}
        }));
      } catch (err) {
        fail('error');
        return handle;
      }
      req.then(function (s) {
        if (!alive) {                        // stopped while the prompt was open: discard the late stream
          stopStream(s);
          if (contexts) releaseSession();
          return;
        }
        captured = true;
        begin(s);
      }, function () {
        if (!alive) return;
        fail('denied');
      });
      return handle;

      function begin(s) {
        stream = s;
        try {
          level = makeLevel(ac, s);
        } catch (e) {
          level = null;
          fail('error');
          return;
        }
        var core = classifier(env.now());
        var phase = 'baseline';

        fire('onStatus', 'baseline');
        if (!alive) return;

        // HINT_MS without a blow: hint (keeps listening)
        timers.push(env.setTimeout(function () {
          if (!alive) return;
          fire('onStatus', 'hint');
        }, TUNING.HINT_MS));
        // never leave the mic open for long
        timers.push(env.setTimeout(function () {
          if (!alive) return;
          fail('timeout');
        }, TUNING.MIC_MAX_MS));

        function tick() {
          if (!alive) return;
          raf = env.raf(tick);
          var r = core.push(level.read(), env.now());
          if (r.phase !== phase) {
            phase = r.phase;
            fire('onStatus', 'listening');
            if (!alive) return;
          }
          fire('onStrength', r.strength);
          if (!alive) return;
          if (r.blown) {
            teardown();
            fire('onBlow', {strength: r.strength});
          }
        }
        raf = env.raf(tick);
      }
    }

    var api = {
      listen: listen,
      classifier: classifier,
      adapters: {analyser: analyserLevel, scripted: scriptedLevel},
      TUNING: TUNING
    };

    if (typeof window !== 'undefined') (window.Card || (window.Card = {})).blowDetector = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;

  } catch (err) {console.error('[blow-detector] failed to load:', err);}
})();
