'use strict';
const test = require('node:test');
const assert = require('node:assert');
const {contextFactory, contexts} = require('../src/audio.js');

/* ---------------------------------------------------------------- fakes */
function fakeCtor(log, opts) {
  opts = opts || {};
  return class {
    constructor(options) {
      if (options && opts.rejectOptions) throw new TypeError('options not supported');
      if (opts.throwAlways) throw new Error('no audio hardware');
      this.options = options;
      this.state = opts.state || 'running';
      this.resumes = 0; this.closes = 0;
      log.push(this);
    }
    resume() {this.resumes++; return opts.rejectResume ? Promise.reject(new Error('not allowed')) : Promise.resolve();}
    close() {this.closes++; this.state = 'closed'; return opts.rejectClose ? Promise.reject(new Error('x')) : Promise.resolve();}
  };
}
function fakeSession(type) {
  const s = {writes: [], _type: type};
  Object.defineProperty(s, 'type', {get() {return s._type;}, set(v) {s.writes.push(v); s._type = v;}});
  return s;
}
const flush = () => new Promise((r) => setImmediate(r));

/* ---------------------------------------------------------------- module shape */
test('audio.js loads in Node and exports the factory (no window, no Card.audio)', () => {
  assert.strictEqual(typeof contextFactory, 'function');
  for (const k of ['supported', 'create', 'resume', 'close', 'releaseCapture']) assert.strictEqual(typeof contexts[k], 'function', k);
});

/* ---------------------------------------------------------------- create */
test('create: passes options, returns a running context', () => {
  const log = [];
  const f = contextFactory({AudioContext: fakeCtor(log)});
  const ac = f.create({latencyHint: 'interactive'});
  assert.strictEqual(log.length, 1);
  assert.deepStrictEqual(ac.options, {latencyHint: 'interactive'});
  assert.strictEqual(ac.resumes, 0, 'running context is not resumed');
});

test('create: falls back to the no-arg constructor when options are rejected (old Safari)', () => {
  const log = [];
  const ac = contextFactory({AudioContext: fakeCtor(log, {rejectOptions: true})}).create({latencyHint: 'interactive'});
  assert.ok(ac);
  assert.strictEqual(ac.options, undefined);
});

test('create: resumes a context that starts suspended, swallowing a rejection', async () => {
  const log = [];
  const ac = contextFactory({AudioContext: fakeCtor(log, {state: 'suspended', rejectResume: true})}).create();
  assert.strictEqual(ac.resumes, 1);
  await flush();                                // an unhandled rejection would fail the run
});

test('create: null when unsupported or when the constructor throws', () => {
  assert.strictEqual(contextFactory({AudioContext: undefined}).create(), null);
  assert.strictEqual(contextFactory({AudioContext: undefined}).supported(), false);
  assert.strictEqual(contextFactory({AudioContext: fakeCtor([], {throwAlways: true})}).create({latencyHint: 'interactive'}), null);
});

/* ---------------------------------------------------------------- resume / close */
test('resume: only for suspended / interrupted (iOS) contexts', () => {
  const f = contextFactory({AudioContext: fakeCtor([])});
  const mk = (state) => ({state, n: 0, resume() {this.n++; return Promise.resolve();}});
  const [r, s, i, c] = ['running', 'suspended', 'interrupted', 'closed'].map(mk);
  [r, s, i, c].forEach(f.resume);
  f.resume(null);
  assert.deepStrictEqual([r.n, s.n, i.n, c.n], [0, 1, 1, 0]);
});

test('close: closes once, ignores null / already closed, swallows rejections', async () => {
  const log = [];
  const f = contextFactory({AudioContext: fakeCtor(log, {rejectClose: true})});
  const ac = f.create();
  f.close(ac);
  f.close(ac);
  f.close(null);
  assert.strictEqual(ac.closes, 1);
  await flush();
});

/* ---------------------------------------------------------------- releaseCapture (iOS audio session) */
test('releaseCapture: kicks a lingering capture session back via playback -> auto', () => {
  for (const start of ['auto', 'play-and-record']) {
    const s = fakeSession(start);
    contextFactory({AudioContext: fakeCtor([]), audioSession: s}).releaseCapture();
    assert.deepStrictEqual(s.writes, ['playback', 'auto'], start);
    assert.strictEqual(s.type, 'auto');
  }
});

test('releaseCapture: leaves a deliberate non-capture choice alone', () => {
  const s = fakeSession('ambient');
  contextFactory({AudioContext: fakeCtor([]), audioSession: s}).releaseCapture();
  assert.deepStrictEqual(s.writes, []);
});

test('releaseCapture: no-op without navigator.audioSession, and never throws', () => {
  contextFactory({AudioContext: fakeCtor([]), audioSession: undefined}).releaseCapture();
  const broken = {get type() {return 'auto';}, set type(v) {throw new Error('read-only');}};
  contextFactory({AudioContext: fakeCtor([]), audioSession: broken}).releaseCapture();
});
