'use strict';
const test = require('node:test');
const assert = require('node:assert');
const createRound = require('../src/round.js');

const T = createRound.TIMING;

/* ---------------------------------------------------------------- fakes */
// fake clock: advance(ms) fires due timers in time order (ties in scheduling order)
function fakeClock() {
  let now = 0, nextId = 1;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout(fn, ms) {const id = nextId++; timers.set(id, {fn, at: now + ms, id}); return id;},
    clearTimeout(id) {timers.delete(id);},
    pending: () => timers.size,
    advance(ms) {
      const end = now + ms;
      for (;;) {
        let next = null;
        for (const t of timers.values()) if (t.at <= end && (!next || t.at < next.at || (t.at === next.at && t.id < next.id))) next = t;
        if (!next) break;
        timers.delete(next.id);
        now = next.at;
        next.fn();
      }
      now = end;
    }
  };
}

// fake beats: every call is logged as "t name args"; the message's typing is finished by the test
function setup(opts = {}) {
  const clock = fakeClock();
  const log = [];
  let rm = !!opts.rm;
  const rec = (name) => (...args) => {log.push({t: clock.now(), name, args: args.filter((a) => typeof a !== 'function')});};
  const fakes = {onTyped: null, onBlown: null, onReplay: null};
  const typingDoneAlready = !!opts.typedAtReveal;
  const beats = {
    cake: {
      rise: (r) => {rec('cake.rise')(r); return opts.noCake ? false : true;},
      light: rec('cake.light'), lightAll: rec('cake.lightAll'), fizzle: rec('cake.fizzle'),
      blowOut: rec('cake.blowOut'), relight: rec('cake.relight'), fold: rec('cake.fold'), reset: rec('cake.reset')
    },
    message: {
      reveal: (cb) => {rec('message.reveal')(); fakes.onTyped = cb; if (typingDoneAlready) cb();},
      showLate: rec('message.showLate'), hideLate: rec('message.hideLate'),
      stop: rec('message.stop'), reset: rec('message.reset')
    },
    finale: {
      showBlowUi: (cb) => {rec('finale.showBlowUi')(); fakes.onBlown = cb;},
      candlesOut: rec('finale.candlesOut'), celebrate: rec('finale.celebrate'),
      manateeIn: rec('finale.manateeIn'), munch: rec('finale.munch'),
      replayReady: (cb) => {rec('finale.replayReady')(); fakes.onReplay = cb;},
      reset: rec('finale.reset')
    },
    emit: (evt) => log.push({t: clock.now(), name: 'emit.' + evt, args: []})
  };
  const round = createRound({beats, clock, reducedMotion: () => rm});
  return {
    clock, log, round, fakes,
    setRm: (v) => {rm = v;},
    lines: (from = 0) => log.slice(from).map((e) => `${e.t} ${e.name}${e.args.length ? '(' + e.args.join(',') + ')' : ''}`),
    names: (from = 0) => log.slice(from).map((e) => e.name)
  };
}

/* ---------------------------------------------------------------- full Rounds */
test('full Round: beat order and times (normal motion)', () => {
  const s = setup();
  s.round.start();
  s.clock.advance(2650);
  assert.equal(s.round.phase(), 'armed');
  s.fakes.onTyped();                 // typing finished before the blow
  s.clock.advance(1000);             // blow at 3650
  s.fakes.onBlown();
  s.clock.advance(5000);
  assert.deepEqual(s.lines(), [
    '0 cake.rise(false)',
    '1350 cake.light(0)',
    '1600 cake.light(1)',
    '1850 cake.fizzle(2)',
    '2450 cake.light(2)',
    '2650 emit.popupDone',
    '2650 message.reveal',
    '2650 finale.showBlowUi',
    '3650 cake.blowOut',
    '3650 finale.candlesOut',
    '3650 emit.candlesOut',
    '4150 finale.celebrate',        // +500
    '4850 finale.manateeIn(false)', // +1200
    '5050 message.showLate',        // +1400
    '5600 finale.munch(0)',         // manatee +750
    '6000 finale.munch(1)',
    '6400 finale.munch(2)',
    '6950 finale.replayReady',      // manatee +2100 = candlesOut +3300
    '6950 emit.finaleDone'
  ]);
  assert.equal(s.round.phase(), 'done');
  assert.equal(s.clock.pending(), 0);
});

test('full Round: beat order and times (reduced motion)', () => {
  const s = setup({rm: true, typedAtReveal: true});
  s.round.start();
  s.clock.advance(350);
  s.fakes.onBlown();                 // blow right at ready (350)
  s.clock.advance(5000);
  assert.deepEqual(s.lines(), [
    '0 cake.rise(true)',
    '150 cake.lightAll',
    '350 emit.popupDone',
    '350 message.reveal',
    '350 finale.showBlowUi',
    '350 cake.blowOut',
    '350 finale.candlesOut',
    '350 emit.candlesOut',
    '850 finale.celebrate',
    '1550 finale.manateeIn(true)',
    '1750 message.showLate',
    '1950 finale.munch(0)',          // manatee +400
    '2350 finale.munch(1)',
    '2750 finale.munch(2)',
    '3300 finale.replayReady',       // manatee +1750 = candlesOut +2950
    '3300 emit.finaleDone'
  ]);
  assert.equal(s.clock.pending(), 0);
});

test('no cake: the Round goes straight to ready', () => {
  const s = setup({noCake: true});
  s.round.start();
  assert.deepEqual(s.names(), ['cake.rise', 'emit.popupDone', 'message.reveal', 'finale.showBlowUi']);
  assert.equal(s.clock.pending(), 0);
});

/* ---------------------------------------------------------------- cancellation */
test('closing mid-rise drops every pending beat; closed resets every module', () => {
  const s = setup();
  s.round.start();
  s.clock.advance(1700);
  const mark = s.log.length;
  s.round.closing();
  assert.equal(s.clock.pending(), 0);
  assert.deepEqual(s.names(mark), ['cake.fold', 'message.stop', 'finale.reset']);
  s.round.closed();
  assert.deepEqual(s.names(mark + 3), ['cake.reset', 'message.reset', 'finale.reset']);
  s.clock.advance(10000);
  assert.equal(s.log.length, mark + 6, 'nothing fires after close');
  assert.equal(s.round.phase(), 'idle');
});

test('closing mid-finale drops confetti, manatee, munches, late part and replayReady', () => {
  const s = setup({typedAtReveal: true});
  s.round.start();
  s.clock.advance(2650);
  s.fakes.onBlown();
  s.clock.advance(600);              // confetti done, manatee pending
  const blown = s.fakes.onBlown, typed = s.fakes.onTyped;
  s.round.closing();
  s.round.closed();
  assert.equal(s.clock.pending(), 0);
  const mark = s.log.length;
  blown(); typed();                  // stale callbacks from the closed Round do nothing
  s.clock.advance(10000);
  assert.equal(s.log.length, mark);
});

test('reopening after a close runs a fresh Round', () => {
  const s = setup();
  s.round.start();
  s.clock.advance(2650);
  s.round.closing(); s.round.closed();
  const mark = s.log.length;
  s.round.start();
  s.clock.advance(2650);
  assert.deepEqual(s.names(mark), ['cake.rise', 'cake.light', 'cake.light', 'cake.fizzle', 'cake.light',
    'emit.popupDone', 'message.reveal', 'finale.showBlowUi']);
});

/* ---------------------------------------------------------------- replay */
test('replay after finaleDone restarts from the relight', () => {
  const s = setup({typedAtReveal: true});
  s.round.start();
  s.clock.advance(2650);
  s.fakes.onBlown();
  s.clock.advance(3300);
  assert.equal(s.round.phase(), 'done');
  const t0 = s.clock.now(), mark = s.log.length;
  s.fakes.onReplay();
  s.clock.advance(450);
  assert.deepEqual(s.lines(mark).map((l) => l.replace(/^\d+/, (n) => String(n - t0))), [
    '0 finale.reset', '0 emit.replay', '0 cake.relight(false)', '0 message.hideLate',
    '450 emit.popupDone', '450 message.reveal', '450 finale.showBlowUi'
  ]);
  // the second Round plays through, late part included
  s.fakes.onBlown();
  s.clock.advance(3300);
  assert.ok(s.names(mark).includes('message.showLate'));
  assert.equal(s.names(mark).at(-1), 'emit.finaleDone');
});

test('replay mid-finale drops the old finale beats and resets correctly', () => {
  const s = setup({typedAtReveal: true});
  s.round.start();
  s.clock.advance(2650);
  s.fakes.onBlown();
  s.clock.advance(1300);             // manatee in, munches pending
  const oldBlown = s.fakes.onBlown;
  const mark = s.log.length;
  s.round.replay();
  assert.deepEqual(s.names(mark), ['finale.reset', 'emit.replay', 'cake.relight', 'message.hideLate']);
  assert.equal(s.clock.pending(), 1, 'only the next ready is pending');
  s.clock.advance(5000);
  assert.deepEqual(s.names(mark + 4), ['emit.popupDone', 'message.reveal', 'finale.showBlowUi'],
    'no munch / late part / replayReady from the old Round');
  oldBlown();
  assert.equal(s.round.phase(), 'armed');
});

test('replay with reduced motion is ready after 60 ms', () => {
  const s = setup({rm: true, typedAtReveal: true});
  s.round.start();
  s.clock.advance(350);
  s.fakes.onBlown();
  s.clock.advance(2950);
  const t0 = s.clock.now(), mark = s.log.length;
  s.fakes.onReplay();
  s.clock.advance(100);
  assert.deepEqual(s.lines(mark).map((l) => l.replace(/^\d+/, (n) => String(n - t0))), [
    '0 finale.reset', '0 emit.replay', '0 cake.relight(true)', '0 message.hideLate',
    '60 emit.popupDone', '60 message.reveal', '60 finale.showBlowUi'
  ]);
});

/* ---------------------------------------------------------------- the late part */
test('blow during typing: the late part waits until typing is done', () => {
  const s = setup();
  s.round.start();
  s.clock.advance(2650);
  s.fakes.onBlown();                 // still typing
  s.clock.advance(4000);             // well past candlesOut + 1400
  assert.ok(!s.names().includes('message.showLate'), 'not before the main text is typed');
  s.clock.advance(500);
  s.fakes.onTyped();                 // typing finishes at 7150
  const late = s.log.filter((e) => e.name === 'message.showLate');
  assert.deepEqual(late.map((e) => e.t), [7150]);
});

test('blow during typing, typing ends before the delay: late part at candlesOut + 1400', () => {
  const s = setup();
  s.round.start();
  s.clock.advance(2650);
  s.fakes.onBlown();
  s.clock.advance(300);
  s.fakes.onTyped();
  s.clock.advance(5000);
  assert.deepEqual(s.log.filter((e) => e.name === 'message.showLate').map((e) => e.t), [2650 + T.late]);
});

test('typing already finished: late part at candlesOut + 1400', () => {
  const s = setup({typedAtReveal: true});
  s.round.start();
  s.clock.advance(3000);
  s.fakes.onBlown();                 // candlesOut at 3000
  s.clock.advance(T.late - 1);
  assert.ok(!s.names().includes('message.showLate'));
  s.clock.advance(1);
  assert.deepEqual(s.log.filter((e) => e.name === 'message.showLate').map((e) => e.t), [3000 + T.late]);
});

test('typing that finishes after a replay does not show the old Round\'s late part', () => {
  const s = setup();
  s.round.start();
  s.clock.advance(2650);
  s.fakes.onBlown();
  s.clock.advance(3300);
  const oldTyped = s.fakes.onTyped;
  s.round.replay();
  oldTyped();
  s.clock.advance(5000);
  assert.ok(!s.names().includes('message.showLate'));
});

/* ---------------------------------------------------------------- exactly once */
test('candles go out exactly once per Round', () => {
  const s = setup({typedAtReveal: true});
  s.round.start();
  s.clock.advance(1000);
  s.round.blown();                   // before ready: ignored
  s.clock.advance(1650);
  s.fakes.onBlown();
  s.fakes.onBlown();                 // mic + taps racing
  s.round.blown();
  s.clock.advance(1000);
  s.fakes.onBlown();
  s.clock.advance(5000);
  const count = (n) => s.names().filter((x) => x === n).length;
  assert.equal(count('cake.blowOut'), 1);
  assert.equal(count('emit.candlesOut'), 1);
  assert.equal(count('finale.celebrate'), 1);
  assert.equal(count('message.showLate'), 1);
  assert.equal(count('emit.finaleDone'), 1);
});

test('reduced motion is read when the manatee comes in, as before', () => {
  const s = setup({typedAtReveal: true});
  s.round.start();
  s.clock.advance(2650);
  s.fakes.onBlown();
  s.clock.advance(1000);
  s.setRm(true);                     // the OS setting flips mid-finale
  s.clock.advance(5000);
  const ready = s.log.find((e) => e.name === 'finale.replayReady');
  assert.equal(ready.t, 2650 + 1200 + 1750);
});

test('the scheduler takes the injected clock and cancels everything at once', () => {
  const clock = fakeClock();
  const sch = createRound.createScheduler(clock);
  let fired = 0;
  sch.at(10, () => fired++); sch.at(20, () => fired++);
  assert.equal(sch.pending(), 2);
  clock.advance(15);
  assert.equal(fired, 1); assert.equal(sch.pending(), 1);
  sch.cancel();
  clock.advance(100);
  assert.equal(fired, 1); assert.equal(clock.pending(), 0);
});
