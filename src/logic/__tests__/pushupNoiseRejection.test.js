// pushupNoiseRejection.test.js
// -----------------------------------------------------------------------------
// REGRESSION TESTS for the phantom-rep bug the user reported from a SIDE-VIEW
// floor push-up session. MoveNet intermittently lost the tracked shoulder/nose
// and emitted GARBAGE upperBodyY values (negative, off-frame, teleporting
// hundreds of px between ~200ms frames). The counter trusted them blindly and
// counted 9 (and 3) reps that never happened, with excursions spiking to 3.764
// and 1.569.
//
// These tests wire the REAL shipped pieces together exactly the way
// WorkoutSession.handlePose does for a push-up frame:
//
//   upperBodyY  ->  createUpperBodySignalValidator.update()  (reject outliers)
//                     |  (ok?)
//                     v
//   createVerticalRepCounter.update(y, ruler, confident && valid, postureOk)
//
// so we prove the fix end-to-end on the pure logic, not just helper-by-helper:
//   (a) a negative / out-of-range upperBodyY frame is REJECTED and does NOT
//       advance the counter;
//   (b) a single huge one-frame spike (teleport 500px then return) does NOT
//       count a rep;
//   (c) a realistic sustained ~0.2-excursion down-then-up over several frames
//       DOES count exactly one rep;
//   (d) the user's exact logged garbage sequence counts ZERO reps.
//
// We use the SAME tuning the app ships for a standard push-up so the thresholds
// under test are the real ones:
//   downFraction 0.16, upFraction 0.06 (from exercises.js standard preset),
//   minDownFrames 2 (from the pushup descriptor),
//   and the validator's default maxJumpFraction 0.75.

import { describe, it, expect } from 'vitest';
import { createVerticalRepCounter } from '../verticalRepCounter.js';
import { createUpperBodySignalValidator } from '../upperBodySignal.js';
import { getExercise, getPreset } from '../exercises.js';

// Build the push-up counter + validator with the EXACT shipped config.
function makePushupPipeline() {
  const preset = getPreset('pushup', 'standard'); // downFraction 0.16, up 0.06
  const counter = createVerticalRepCounter({
    downFraction: preset.downFraction,
    upFraction: preset.upFraction,
    minDownFrames: getExercise('pushup').minDownFrames, // 2
  });
  const validator = createUpperBodySignalValidator();
  return { counter, validator, preset };
}

// Feed one frame through the real pipeline. `confident` mirrors the per-joint
// confidence gate; the validator result is ANDed into it exactly like
// WorkoutSession does. Returns the reject reason (or null) for assertions.
function feed(pipeline, upperBodyY, ruler, { confident = true, postureOk = true } = {}) {
  const verdict = pipeline.validator.update(upperBodyY, ruler);
  const frameConfident = confident && verdict.ok;
  pipeline.counter.update(upperBodyY, ruler, frameConfident, postureOk);
  return verdict.reason;
}

// The user's locked ruler from the first diagnostics run.
const RULER = 255.6;

describe('push-up noise rejection (end-to-end validator + counter)', () => {
  it('(a) a NEGATIVE / out-of-range upperBodyY is rejected and never advances the counter', () => {
    const p = makePushupPipeline();

    // A sane resting frame learns the baseline.
    feed(p, 558, RULER);
    expect(p.counter.phase).toBe('up');

    // The logged garbage: negative and impossible values. Each is rejected, so
    // the counter sees them as not-confident and does not move.
    expect(feed(p, -39, RULER)).toBe('negative');
    expect(feed(p, -19, RULER)).toBe('negative');
    expect(feed(p, -64, RULER)).toBe('negative');

    expect(p.counter.phase).toBe('up');
    expect(p.counter.reps).toBe(0);
  });

  it('(b) a single huge one-frame spike (teleport 500px then return) does NOT count a rep', () => {
    const p = makePushupPipeline();

    // Rest around a sane value.
    feed(p, 300, RULER);
    feed(p, 300, RULER);

    // One garbage frame teleports ~500px below, then the signal returns to
    // rest. Against a 255px ruler that jump is ~2 body-scales -> rejected, so
    // it never enters 'down' and cannot complete a rep.
    expect(feed(p, 804, RULER)).toBe('teleport');
    feed(p, 300, RULER); // back to rest

    expect(p.counter.reps).toBe(0);
    expect(p.counter.phase).toBe('up');
  });

  it('(c) a realistic sustained ~0.2-excursion down-then-up counts EXACTLY one rep', () => {
    const p = makePushupPipeline();
    // All values stay in-frame and move only a small fraction of the ruler per
    // frame, so the validator accepts every one.
    const base = 500;
    // Descend gradually to ~0.22 of the ruler below rest (0.22*255.6 ~ 56px),
    // comfortably past downFraction 0.16, over several frames.
    const down = [500, 515, 530, 545, 556]; // each step ~0.06 of ruler
    // Rise back to ~0.03 of the ruler (below upFraction 0.06).
    const up = [540, 525, 512, 508]; // end excursion ~0.03

    feed(p, base, RULER); // baseline
    for (const y of down) feed(p, y, RULER);
    expect(p.counter.phase).toBe('down'); // the real dip reached 'down'
    for (const y of up) feed(p, y, RULER);

    expect(p.counter.reps).toBe(1);
    expect(p.counter.phase).toBe('up');
  });

  it('(c2) two genuine sustained dips in a row count exactly two reps', () => {
    const p = makePushupPipeline();
    const cycle = (baseY) => {
      feed(p, baseY, RULER);
      feed(p, baseY + 20, RULER);
      feed(p, baseY + 45, RULER); // ~0.18 of ruler -> down (sustained)
      feed(p, baseY + 40, RULER); // still down (2nd down frame)
      feed(p, baseY + 8, RULER); // ~0.03 -> up -> rep
    };
    feed(p, 500, RULER); // learn baseline
    cycle(500);
    cycle(505);
    expect(p.counter.reps).toBe(2);
  });

  it("(d) the user's exact logged garbage sequence counts ZERO reps", () => {
    const p = makePushupPipeline();

    // The exact upperBodyY values the user pasted from the console, in order.
    // First a few sane resting values, then the detector loses the joint and
    // emits negatives / teleports.
    const logged = [558, 537, 567, -39, -19, 7, -16, -27, -6, 34, 182, 504];

    let rejections = 0;
    for (const y of logged) {
      const reason = feed(p, y, RULER);
      if (reason) rejections += 1;
    }

    // Nothing in this standing/garbage stream is a real push-up, so ZERO reps.
    expect(p.counter.reps).toBe(0);
    // And the garbage really was filtered (not silently accepted).
    expect(rejections).toBeGreaterThan(0);
  });

  it("(d2) the second run's garbage (right side, ruler 313.7) also counts ZERO", () => {
    const preset = getPreset('pushup', 'standard');
    const counter = createVerticalRepCounter({
      downFraction: preset.downFraction,
      upFraction: preset.upFraction,
      minDownFrames: getExercise('pushup').minDownFrames,
    });
    const validator = createUpperBodySignalValidator();
    const ruler = 313.7;

    const logged = [560, 545, -64, 2, 21, 182, 504, -10, 48, 500];
    for (const y of logged) {
      const verdict = validator.update(y, ruler);
      counter.update(y, ruler, verdict.ok, true);
    }
    expect(counter.reps).toBe(0);
  });

  it('a garbage frame in the MIDDLE of a real set does not add a phantom rep', () => {
    const p = makePushupPipeline();
    // One clean rep...
    feed(p, 500, RULER);
    feed(p, 520, RULER);
    feed(p, 548, RULER); // down
    feed(p, 544, RULER); // sustained down
    feed(p, 508, RULER); // up -> rep 1
    expect(p.counter.reps).toBe(1);

    // ...then a burst of garbage (negative + teleport) that must add nothing...
    expect(feed(p, -30, RULER)).toBe('negative');
    expect(feed(p, 900, RULER)).toBe('teleport');
    feed(p, 505, RULER); // back to a sane rest

    // ...then a second clean rep -> total 2, no phantom from the garbage.
    feed(p, 525, RULER);
    feed(p, 550, RULER); // down
    feed(p, 546, RULER); // sustained down
    feed(p, 509, RULER); // up -> rep 2
    expect(p.counter.reps).toBe(2);
  });
});
