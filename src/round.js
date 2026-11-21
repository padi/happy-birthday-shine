; (function () {
  'use strict';
  try {
    /* round.js - the Round module: one play of the card, from the cake rising to Replay being ready.

         cake rises -> candles light (3rd fizzles, then catches) -> [ready] message types + blow UI
         -> blown -> candles out + whoosh -> confetti + pop -> manatee slides in, munches x3
         -> late part of the message (never before the main text has finished typing)
         -> Replay ready ('finaleDone'). Replay starts a new Round from the relight.

       Interface (deep: a handful of calls hide the whole timeline):
         var round = createRound({ beats, reducedMotion, clock, onBeat })
           round.start()    the card has opened: run a Round from the rise
           round.replay()   start a new Round from the relight (the Replay button)
           round.blown()    the candles were blown out (mic or taps); ignored unless the Round is armed,
                            so the candles go out exactly once per Round
           round.closing()  the card is folding shut: drop every pending beat, fold the cake
           round.closed()   the card is shut: drop every pending beat, reset every module
           round.phase()    'idle' | 'rising' | 'armed' | 'finale' | 'done'
         createRound.TIMING  the timeline (ms), normal and reduced-motion

       Implementation: every cross-module delay lives in TIMING below and is scheduled on ONE timer list
       (the scheduler), so cancel() drops every pending beat at once. Each Round also gets a token, so a
       callback handed to a beat in an earlier Round (e.g. "typing finished") is ignored after a replay.

       Seam: `beats` is the adapter to the performing modules. Every beat is a "do this now" call with no
       timing of its own; a missing module or beat is skipped. In the browser the adapter is built from
       Card.cake (popup.js), Card.message (message.js) and Card.finale (finale.js) at call time:
         cake:    rise(rm) -> false if there is no cake, light(i), lightAll(), fizzle(i), blowOut(),
                  relight(rm), fold(), reset()
         message: reveal(onTyped) - onTyped() once the main text is fully shown (now, if it already is),
                  showLate(), hideLate(), stop(), reset()
         finale:  showBlowUi(onBlown), candlesOut() (blow UI off + whoosh), celebrate() (confetti + pop),
                  manateeIn(rm), munch(k), replayReady(onReplay), reset()
         emit(evt) the bus: 'popupDone', 'candlesOut', 'finaleDone', 'replay' are still emitted for anyone
                  listening, but no module relies on them for the sequence any more.

       The clock is injected ({ setTimeout, clearTimeout, now }, defaulting to the globals) so tests drive
       a Round with a fake clock. Loadable in Node (module.exports) and in the page (window.Card.round). */

    var TIMING = {
      // the rise: candles, then the Round is ready (blow UI + message)
      rise: [
        {at: 1350, beat: 'light', candle: 0},
        {at: 1600, beat: 'light', candle: 1},
        {at: 1850, beat: 'fizzle', candle: 2},   // spark + tiny smoke, the flame dies...
        {at: 2450, beat: 'light', candle: 2}     // ...and catches ~0.6s later
      ],
      riseReady: 2650,
      rmLightAll: 150, rmRiseReady: 350,           // reduced motion: appear quickly, no fizzle
      replayReady: 450, rmReplayReady: 60,         // relight (popup staggers the flames 110 ms) -> ready
      // after the candles are out
      confetti: 500,
      manatee: 1200,
      late: 1400,                                  // after the confetti has landed
      slide: 800, rmSlide: 450,                    // manatee entrance (CSS) - the munches start just before it ends
      munchLead: 50, munchGap: 400, munches: 3,
      settle: 550                                  // last munch -> Replay ready
    };

    /* ------------------------------------------------------------------ scheduler */
    // one timer list for the whole Round: at(ms, fn) schedules, cancel() drops everything pending
    function createScheduler(clock) {
      clock = clock || {};
      var set = clock.setTimeout || function (fn, ms) {return setTimeout(fn, ms);};
      var clear = clock.clearTimeout || function (id) {clearTimeout(id);};
      var now = clock.now || function () {return Date.now();};
      var ids = [];
      return {
        now: now,
        at: function (ms, fn) {
          var id = set(function () {
            var i = ids.indexOf(id);
            if (i >= 0) ids.splice(i, 1);
            fn();
          }, ms);
          ids.push(id);
          return id;
        },
        cancel: function () {while (ids.length) clear(ids.pop());},
        pending: function () {return ids.length;}
      };
    }

    /* ------------------------------------------------------------------ the Round */
    function createRound(opts) {
      opts = opts || {};
      var beats = opts.beats || {};
      var rmFn = opts.reducedMotion || function () {return false;};
      var sched = createScheduler(opts.clock);
      var onBeat = opts.onBeat || null;

      var token = 0;          // bumped by every new Round and every cancel
      var phase = 'idle';
      var late = null;        // the late-part gate of the current Round: { typed, due, shown }

      function rm() {return !!rmFn();}

      // perform one beat on one module (skipped when the module / beat is missing)
      function beat(mod, name) {
        var m = typeof beats[mod] === 'function' ? beats[mod]() : beats[mod];
        var fn = m && m[name];
        if (onBeat) onBeat(mod + '.' + name, sched.now(), Array.prototype.slice.call(arguments, 2));
        if (typeof fn !== 'function') return undefined;
        return fn.apply(m, Array.prototype.slice.call(arguments, 2));
      }
      function emit(evt) {
        if (onBeat) onBeat('emit.' + evt, sched.now(), []);
        if (typeof beats.emit === 'function') beats.emit(evt);
      }
      // a callback that only works while the Round that made it is current
      function bound(fn) {
        var t = token;
        return function () {if (t === token) fn.apply(null, arguments);};
      }
      function at(ms, fn) {sched.at(ms, bound(fn));}

      function cancel() {
        sched.cancel();
        token++;
        phase = 'idle';
        late = null;
      }

      /* ready: the message types and the blow UI shows (was the 'popupDone' wiring) */
      function ready() {
        phase = 'armed';
        late = {typed: false, due: false, shown: false};
        emit('popupDone');
        beat('message', 'reveal', bound(typed));
        beat('finale', 'showBlowUi', bound(blown));
      }

      /* the late part needs BOTH: the main text fully typed, and LATE ms after the candles went out */
      function typed() {if (late) {late.typed = true; maybeLate();}}
      function maybeLate() {
        if (!late || late.shown || !late.typed || !late.due) return;
        late.shown = true;
        beat('message', 'showLate');
      }

      function start() {
        cancel();
        phase = 'rising';
        var reduced = rm();
        if (beat('cake', 'rise', reduced) === false) {ready(); return;}   // no cake: straight to ready
        if (reduced) {
          at(TIMING.rmLightAll, function () {beat('cake', 'lightAll');});
          at(TIMING.rmRiseReady, ready);
          return;
        }
        TIMING.rise.forEach(function (s) {
          at(s.at, function () {beat('cake', s.beat, s.candle);});
        });
        at(TIMING.riseReady, ready);
      }

      function blown() {
        if (phase !== 'armed') return;   // exactly once per Round
        phase = 'finale';
        beat('cake', 'blowOut');
        beat('finale', 'candlesOut');
        emit('candlesOut');
        at(TIMING.confetti, function () {beat('finale', 'celebrate');});
        at(TIMING.manatee, manateeIn);
        at(TIMING.late, function () {if (late) {late.due = true; maybeLate();}});
      }

      function manateeIn() {
        var reduced = rm();
        beat('finale', 'manateeIn', reduced);
        var munchAt = (reduced ? TIMING.rmSlide : TIMING.slide) - TIMING.munchLead;
        for (var k = 0; k < TIMING.munches; k++) {
          (function (k) {at(munchAt + k * TIMING.munchGap, function () {beat('finale', 'munch', k);});})(k);
        }
        at(munchAt + (TIMING.munches - 1) * TIMING.munchGap + TIMING.settle, function () {
          phase = 'done';
          beat('finale', 'replayReady', bound(replay));
          emit('finaleDone');
        });
      }

      function replay() {
        cancel();
        phase = 'rising';
        var reduced = rm();
        beat('finale', 'reset');
        emit('replay');
        beat('cake', 'relight', reduced);
        beat('message', 'hideLate');   // the main text stays shown (not retyped)
        at(reduced ? TIMING.rmReplayReady : TIMING.replayReady, ready);
      }

      function closing() {
        cancel();
        beat('cake', 'fold');
        beat('message', 'stop');
        beat('finale', 'reset');
      }

      function closed() {
        cancel();
        beat('cake', 'reset');
        beat('message', 'reset');
        beat('finale', 'reset');
      }

      return {
        start: start,
        replay: replay,
        blown: blown,
        closing: closing,
        closed: closed,
        cancel: cancel,
        phase: function () {return phase;},
        pending: sched.pending
      };
    }
    createRound.TIMING = TIMING;
    createRound.createScheduler = createScheduler;

    /* ------------------------------------------------------------------ page wiring */
    var Card = typeof window !== 'undefined' ? window.Card : null;
    if (Card && typeof Card.on === 'function') {
      var round = createRound({
        reducedMotion: function () {return !!Card.reducedMotion;},
        beats: {   // adapter: looked up at call time, so a module that failed to load is just skipped
          cake: function () {return Card.cake;},
          message: function () {return Card.message;},
          finale: function () {return Card.finale;},
          emit: function (evt) {Card.emit(evt);}
        }
      });
      round.create = createRound;
      Card.round = round;
      Card.on('opened', round.start);
      Card.on('closing', round.closing);
      Card.on('closed', round.closed);
    }
    if (typeof module !== 'undefined' && module.exports) module.exports = createRound;

  } catch (err) {console.error('[round] failed to load:', err);}
})();
