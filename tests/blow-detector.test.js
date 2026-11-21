'use strict';
const test = require('node:test');
const assert = require('node:assert');
const det = require('../src/blow-detector.js');

const T = det.TUNING;
const FRAME = 16;

/* ---------------------------------------------------------------- fakes */
// fake clock driving rAF + timers; advance(ms) runs frames every FRAME ms and fires due timers
function fakeClock() {
  let now = 0, nextId = 1;
  let frames = new Map();
  const timers = new Map();
  const c = {
    now: () => now,
    raf(fn) {const id = nextId++; frames.set(id, fn); return id;},
    caf(id) {frames.delete(id);},
    setTimeout(fn, ms) {const id = nextId++; timers.set(id, {fn, at: now + ms}); return id;},
    clearTimeout(id) {timers.delete(id);},
    pendingTimers: () => timers.size,
    pendingFrames: () => frames.size,
    advance(ms) {
      const end = now + ms;
      while (now + FRAME <= end) {
        now += FRAME;
        for (const [id, t] of [...timers]) if (t.at <= now) {timers.delete(id); t.fn();}
        const run = frames; frames = new Map();
        for (const fn of run.values()) fn();
      }
    }
  };
  return c;
}

function fakeStream() {
  const tracks = [{stopped: false, stop() {this.stopped = true;}}];
  return {tracks, getTracks: () => tracks};
}

function fakeAudioContext(log) {
  return class {
    constructor() {this.state = 'running'; this.closed = false; log.push(this);}
    close() {this.closed = true; return Promise.resolve();}
  };
}

// mediaDevices whose getUserMedia resolves / rejects when the test says so
function deferredMedia() {
  const m = {calls: [], getUserMedia(constraints) {
    return new Promise((resolve, reject) => m.calls.push({constraints, resolve, reject}));
  }};
  return m;
}

const flush = () => new Promise((r) => setImmediate(r));

// starts a session with scripted dB per frame; returns {clock, events, handle, ctxs, stream}
async function session(dbs, extra) {
  const clock = fakeClock();
  const ctxs = [];
  const media = deferredMedia();
  const events = {status: [], strength: [], blow: 0, fail: []};
  const handle = det.listen({
    onStatus: (s) => events.status.push(s),
    onStrength: (v) => events.strength.push(v),
    onBlow: () => events.blow++,
    onFail: (r) => events.fail.push(r)
  }, Object.assign({
    level: det.adapters.scripted(dbs),
    env: {
      mediaDevices: media, AudioContext: fakeAudioContext(ctxs), isSecureContext: true,
      now: clock.now, raf: clock.raf, caf: clock.caf,
      setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout
    }
  }, extra || {}));
  const stream = fakeStream();
  if (media.calls.length) media.calls[0].resolve(stream);
  await flush();
  return {clock, events, handle, ctxs, stream, media};
}

// dB per frame index: `room` dB, plus `loud` dB during the given [startMs, endMs) ranges
function profile(room, loud, ranges) {
  return (i) => {
    const t = (i + 1) * FRAME;
    return ranges.some(([a, b]) => t >= a && t < b) ? loud : room;
  };
}

/* ---------------------------------------------------------------- classifier (pure core) */
test('classifier: silence never blows', () => {
  const c = det.classifier(0);
  for (let t = FRAME; t <= 20000; t += FRAME) {
    const r = c.push(-60, t);
    assert.strictEqual(r.blown, false);
    assert.strictEqual(r.strength, 0);
  }
});

test('classifier: baseline phase lasts BASELINE_MS, strength 0 meanwhile', () => {
  const c = det.classifier(0);
  let t = 0, r;
  do {t += FRAME; r = c.push(t < 200 ? -60 : 0, t);} while (r.phase === 'baseline');
  assert.ok(t >= T.BASELINE_MS && t < T.BASELINE_MS + FRAME, 'baseline ends at ' + t);
});

test('classifier: sustained blow blows exactly once', () => {
  const c = det.classifier(0);
  let blows = 0, firstAt = null;
  for (let t = FRAME; t <= 3000; t += FRAME) {
    const r = c.push(t >= 500 ? -20 : -60, t);   // 40 dB over ambient from 500 ms on
    if (r.blown) {blows++; if (firstAt === null) firstAt = t;}
  }
  assert.strictEqual(blows, 1);
  assert.ok(firstAt >= 500 + T.NEED_MS - FRAME && firstAt <= 500 + T.NEED_MS + FRAME, 'blew at ' + firstAt);
});

test('classifier: smoothing is quick attack, soft release', () => {
  const c = det.classifier(0);
  let t = 0;
  for (; t < 400; t += FRAME) c.push(-60, t + FRAME);
  t += FRAME;
  assert.strictEqual(c.push(-60 + T.DB_START + T.DB_SPAN / 2, t).strength, 0.5);   // attack: immediate
  t += FRAME;
  const r = c.push(-60, t);                                                      // release: 0.5*0.8
  assert.ok(Math.abs(r.strength - 0.4) < 1e-9, String(r.strength));
});

/* ---------------------------------------------------------------- listen() through the scripted adapter */
test('listen: statuses, constraints and silence never blows', async () => {
  const s = await session(() => -60);
  assert.deepStrictEqual(s.media.calls[0].constraints,
    {audio: {echoCancellation: false, noiseSuppression: false, autoGainControl: false}});
  s.clock.advance(5000);
  assert.deepStrictEqual(s.events.status, ['requesting', 'baseline', 'listening']);
  assert.strictEqual(s.events.blow, 0);
  assert.ok(s.events.strength.every((v) => v === 0));
  s.handle.stop();
});

test('listen: sustained blow (>= 400 ms over threshold in 1 s) blows once and tears down', async () => {
  const s = await session(profile(-60, -20, [[600, 2000]]));
  s.clock.advance(3000);
  assert.strictEqual(s.events.blow, 1);
  assert.deepStrictEqual(s.events.fail, []);
  assert.ok(s.stream.tracks[0].stopped, 'tracks stopped');
  assert.ok(s.ctxs[0].closed, 'context closed');
  assert.strictEqual(s.clock.pendingFrames(), 0, 'rAF loop stopped');
  assert.strictEqual(s.clock.pendingTimers(), 0, 'hint / max timers cleared');
  const n = s.events.strength.length;
  s.clock.advance(1000);
  assert.strictEqual(s.events.strength.length, n, 'no callbacks after the blow');
});

test('listen: short bursts (2 x 150 ms, 1 s apart) do not blow', async () => {
  const s = await session(profile(-60, -20, [[600, 750], [1750, 1900]]));
  s.clock.advance(4000);
  assert.strictEqual(s.events.blow, 0);
  assert.ok(Math.max(...s.events.strength) > T.THRESHOLD, 'bursts were loud enough');
  s.handle.stop();
});

test('listen: a loud-but-steady room is the baseline and does not blow', async () => {
  const s = await session(() => -25);
  s.clock.advance(5000);
  assert.strictEqual(s.events.blow, 0);
  assert.ok(s.events.strength.every((v) => v === 0));
  s.handle.stop();
});

test('listen: DB_FLOOR clamps digital silence', async () => {
  // baseline of -140 dB would make a -75 dB level 65 dB "over ambient" and blow; clamped to -85 it is
  // only 10 dB over: strength (10 - 6) / 18 = 0.22 < THRESHOLD.
  const s = await session(profile(-140, T.DB_FLOOR + 10, [[600, 5000]]));
  s.clock.advance(5000);
  assert.strictEqual(s.events.blow, 0);
  const peak = Math.max(...s.events.strength);
  assert.ok(Math.abs(peak - (10 - T.DB_START) / T.DB_SPAN) < 1e-9, String(peak));
});

test('listen: hint after HINT_MS, timeout after MIC_MAX_MS', async () => {
  const s = await session(() => -60);
  s.clock.advance(T.HINT_MS + 100);
  assert.strictEqual(s.events.status.at(-1), 'hint');
  s.clock.advance(T.MIC_MAX_MS - T.HINT_MS);
  assert.deepStrictEqual(s.events.fail, ['timeout']);
  assert.ok(s.stream.tracks[0].stopped);
  assert.ok(s.ctxs[0].closed);
});

test('listen: stop() during a pending permission prompt discards the late stream', async () => {
  const clock = fakeClock();
  const ctxs = [];
  const media = deferredMedia();
  const events = [];
  const h = det.listen({
    onStatus: (s) => events.push('status:' + s),
    onStrength: () => events.push('strength'),
    onBlow: () => events.push('blow'),
    onFail: (r) => events.push('fail:' + r)
  }, {
    level: det.adapters.scripted([-60]),
    env: {mediaDevices: media, AudioContext: fakeAudioContext(ctxs), isSecureContext: true,
      now: clock.now, raf: clock.raf, caf: clock.caf, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout}
  });
  assert.deepStrictEqual(events, ['status:requesting']);
  h.stop();
  h.stop();                                   // idempotent
  assert.ok(ctxs[0].closed, 'context closed on stop');
  const late = fakeStream();
  media.calls[0].resolve(late);
  await flush();
  clock.advance(1000);
  assert.ok(late.tracks[0].stopped, 'late stream tracks stopped');
  assert.deepStrictEqual(events, ['status:requesting'], 'no callbacks after stop');
  assert.strictEqual(clock.pendingFrames(), 0);
});

test('listen: permission denied -> onFail("denied")', async () => {
  const ctxs = [];
  const media = deferredMedia();
  const fails = [];
  det.listen({onFail: (r) => fails.push(r)},
    {env: {mediaDevices: media, AudioContext: fakeAudioContext(ctxs), isSecureContext: true}});
  media.calls[0].reject(new Error('NotAllowedError'));
  await flush();
  assert.deepStrictEqual(fails, ['denied']);
  assert.ok(ctxs[0].closed);
});

test('listen: missing support fails synchronously with "unsupported"', () => {
  const fails = [];
  det.listen({onFail: (r) => fails.push(r)}, {env: {mediaDevices: undefined, AudioContext: fakeAudioContext([])}});
  det.listen({onFail: (r) => fails.push(r)}, {env: {mediaDevices: deferredMedia(), AudioContext: undefined}});
  det.listen({onFail: (r) => fails.push(r)},
    {env: {mediaDevices: deferredMedia(), AudioContext: fakeAudioContext([]), isSecureContext: false}});
  assert.deepStrictEqual(fails, ['unsupported', 'unsupported', 'unsupported']);
});

/* ---------------------------------------------------------------- production analyser adapter */
function fakeAnalyserCtx(fill, opts) {
  const nodes = [];
  const ctx = {
    state: 'running', sampleRate: 48000,
    createMediaStreamSource() {
      const n = {disconnected: false, connect() {}, disconnect() {this.disconnected = true;}};
      nodes.push(n); return n;
    },
    createAnalyser() {
      const n = {fftSize: 0, frequencyBinCount: 1024, minDecibels: -100, maxDecibels: -30,
        disconnected: false, connect() {}, disconnect() {this.disconnected = true;}};
      if (opts && opts.bytes) n.getByteFrequencyData = (a) => a.fill(fill);
      else n.getFloatFrequencyData = (a) => a.fill(fill);
      nodes.push(n); return n;
    }
  };
  return {ctx, nodes};
}

test('analyser adapter: float band level, -Infinity reads as digital silence, close disconnects', () => {
  let {ctx, nodes} = fakeAnalyserCtx(-50);
  let lvl = det.adapters.analyser(ctx, fakeStream());
  assert.ok(Math.abs(lvl.read() - -50) < 1e-6);
  assert.strictEqual(nodes[1].fftSize, 2048);
  lvl.close();
  assert.ok(nodes.every((n) => n.disconnected));
  ({ctx} = fakeAnalyserCtx(-Infinity));
  lvl = det.adapters.analyser(ctx, fakeStream());
  // -Infinity bins count as -140 dB; plus the 1e-14 epsilon: 10*log10(2e-14) ~ -137 dB, well under DB_FLOOR
  assert.ok(Math.abs(lvl.read() - 10 * Math.log10(2e-14)) < 1e-6);
});

test('analyser adapter: getByteFrequencyData fallback maps bytes onto min..max dB', () => {
  const {ctx} = fakeAnalyserCtx(255, {bytes: true});
  const lvl = det.adapters.analyser(ctx, fakeStream());
  assert.ok(Math.abs(lvl.read() - -30) < 1e-6);
});

/* ---------------------------------------------------------------- context ownership (audio.js factory seam) */
// a fake contexts adapter (the shape of audio.js contextFactory()) that records every lifecycle call
function fakeContexts(log) {
  const made = [];
  const c = {
    made, calls: log,
    supported: () => true,
    create(options) {const ac = {state: 'running', options}; made.push(ac); log.push(['create', ac]); return ac;},
    resume(ac) {log.push(['resume', ac]);},
    close(ac) {log.push(['close', ac]);},
    releaseCapture() {log.push(['release']);}
  };
  return c;
}

async function ownedSession(dbs, outputCtx) {
  const clock = fakeClock();
  const log = [];
  const contexts = fakeContexts(log);
  const media = deferredMedia();
  const events = {blow: 0, fail: []};
  const stream = fakeStream();
  // record the moment tracks stop, relative to the lifecycle calls
  stream.tracks[0].stop = function () {this.stopped = true; log.push(['tracks-stopped']);};
  const handle = det.listen({onBlow: () => events.blow++, onFail: (r) => events.fail.push(r)}, {
    level: det.adapters.scripted(dbs),
    env: {mediaDevices: media, contexts, isSecureContext: true, now: clock.now, raf: clock.raf, caf: clock.caf,
      setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout}
  });
  media.calls[0].resolve(stream);
  await flush();
  return {clock, log, contexts, events, handle, stream, outputCtx};
}
const closes = (log) => log.filter((e) => e[0] === 'close').map((e) => e[1]);

for (const [name, run] of [
  ['stop()', (s) => s.handle.stop()],
  ['a blow', (s) => s.clock.advance(3000)],
  ['a failure (timeout)', (s) => s.clock.advance(T.MIC_MAX_MS + 100)]
]) {
  test('context ownership: on ' + name + ' tracks stop, only the detector\'s own context closes, then the session is released', async () => {
    const output = {state: 'running', name: 'sound bus'};       // a context the detector must never touch
    const s = await ownedSession(name === 'a blow' ? profile(-60, -20, [[600, 2000]]) : () => -60, output);
    assert.strictEqual(s.contexts.made.length, 1, 'exactly one context created, synchronously in listen()');
    run(s);
    if (name === 'a blow') assert.strictEqual(s.events.blow, 1);
    if (name.startsWith('a failure')) assert.deepStrictEqual(s.events.fail, ['timeout']);
    assert.ok(s.stream.tracks[0].stopped, 'tracks stopped');
    assert.deepStrictEqual(closes(s.log), [s.contexts.made[0]], 'closes its own capture context, once');
    assert.ok(!closes(s.log).includes(output), 'never closes a context it did not create');
    const order = s.log.map((e) => e[0]).filter((k) => k !== 'resume');
    assert.deepStrictEqual(order, ['create', 'tracks-stopped', 'close', 'release'], 'session released after tracks stop');
    s.handle.stop();                                          // idempotent: nothing more happens
    assert.strictEqual(s.log.length, order.length);
  });
}

test('context ownership: created inside the gesture, before getUserMedia resolves', () => {
  const log = [];
  const contexts = fakeContexts(log);
  const media = deferredMedia();
  const h = det.listen({}, {env: {mediaDevices: media, contexts, isSecureContext: true}});
  assert.strictEqual(contexts.made.length, 1, 'context exists synchronously');
  assert.strictEqual(media.calls.length, 1);
  h.stop();
});

test('context ownership: denied permission closes the context but does not touch the audio session', async () => {
  const log = [];
  const contexts = fakeContexts(log);
  const media = deferredMedia();
  det.listen({}, {env: {mediaDevices: media, contexts, isSecureContext: true}});
  media.calls[0].reject(new Error('NotAllowedError'));
  await flush();
  assert.deepStrictEqual(log.map((e) => e[0]), ['create', 'close']);
});

test('context ownership: a late stream after stop() is stopped and the session released', async () => {
  const log = [];
  const contexts = fakeContexts(log);
  const media = deferredMedia();
  const h = det.listen({}, {env: {mediaDevices: media, contexts, isSecureContext: true}});
  h.stop();
  const late = fakeStream();
  media.calls[0].resolve(late);
  await flush();
  assert.ok(late.tracks[0].stopped);
  assert.deepStrictEqual(log.map((e) => e[0]), ['create', 'close', 'release']);
});

test('context ownership: unsupported when the factory cannot make a context', () => {
  const fails = [];
  const contexts = Object.assign(fakeContexts([]), {supported: () => true, create: () => null});
  det.listen({onFail: (r) => fails.push(r)}, {env: {mediaDevices: deferredMedia(), contexts, isSecureContext: true}});
  det.listen({onFail: (r) => fails.push(r)},
    {env: {mediaDevices: deferredMedia(), contexts: Object.assign(fakeContexts([]), {supported: () => false})}});
  assert.deepStrictEqual(fails, ['unsupported', 'unsupported']);
});

test('default seam: env.AudioContext + env.audioSession go through audio.js contextFactory', async () => {
  const ctxs = [];
  const session = {type: 'play-and-record'};
  const clock = fakeClock();
  const media = deferredMedia();
  const h = det.listen({}, {level: det.adapters.scripted([-60]), env: {
    mediaDevices: media, AudioContext: fakeAudioContext(ctxs), audioSession: session, isSecureContext: true,
    now: clock.now, raf: clock.raf, caf: clock.caf, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout}});
  media.calls[0].resolve(fakeStream());
  await flush();
  h.stop();
  assert.strictEqual(ctxs.length, 1);
  assert.ok(ctxs[0].closed, 'own context closed through the factory');
  assert.strictEqual(session.type, 'auto', 'session kicked back after capture');
});
