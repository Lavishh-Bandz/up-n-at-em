// pushupDiagnostics.test.js
// Pure unit tests for the "click Begin -> leave a report" diagnostics recorder.
// Push-ups are counted from the 3D ELBOW JOINT ANGLE (degrees), so the recorder
// tracks the smoothed elbow angle each frame against the down/up angle
// thresholds: bend PAST downAngle (angle <= downAngle) to reach the bottom,
// straighten PAST upAngle (angle >= upAngle) to complete the rep.
import { describe, it, expect } from 'vitest';
import { createPushupDiagnostics } from '../pushupDiagnostics.js';

describe('createPushupDiagnostics', () => {
  it('is inactive until start() and ignores samples before start', () => {
    const diag = createPushupDiagnostics();
    expect(diag.active).toBe(false);
    diag.sample({ angle: 120, downAngle: 100 }, 100);
    expect(diag.report.samples).toHaveLength(0);
    expect(diag.report.summary.sampleCount).toBe(0);
  });

  it('records set context and samples once started', () => {
    const diag = createPushupDiagnostics();
    diag.start(
      {
        exercise: 'pushup',
        difficulty: 'standard',
        targetReps: 20,
        downAngle: 100,
        upAngle: 155,
        side: 'left',
      },
      1000
    );
    expect(diag.active).toBe(true);

    diag.sample(
      {
        angle: 152.4,
        rawAngle: 150.1,
        downAngle: 100,
        upAngle: 155,
        confident: true,
        armed: true,
        phase: 'up',
        postureOk: true,
        reps: 0,
      },
      1050
    );

    const { report } = diag;
    expect(report.meta.exercise).toBe('pushup');
    expect(report.meta.downAngle).toBe(100);
    expect(report.meta.upAngle).toBe(155);
    expect(report.samples).toHaveLength(1);
    const s = report.samples[0];
    // Timestamps are stored relative to start and rounded.
    expect(s.tMs).toBe(50);
    expect(s.angle).toBe(152.4); // rounded to one decimal
    expect(s.rawAngle).toBe(150.1);
    expect(s.phase).toBe('up');
    expect(s.postureOk).toBe(true);
  });

  it('tracks min/max/last angle and whether the down threshold was reached', () => {
    const diag = createPushupDiagnostics();
    diag.start({ downAngle: 100, upAngle: 155 }, 0);
    diag.sample({ angle: 160, downAngle: 100 }, 10); // up (straight)
    diag.sample({ angle: 92, downAngle: 100 }, 20); // bent past down
    diag.sample({ angle: 150, downAngle: 100 }, 30); // back up

    const { summary } = diag.report;
    expect(summary.sampleCount).toBe(3);
    expect(summary.minAngle).toBe(92);
    expect(summary.maxAngle).toBe(160);
    expect(summary.lastAngle).toBe(150);
    expect(summary.downAngleReached).toBe(true);
  });

  it('reports downAngleReached=false when the elbow never bends deep enough', () => {
    const diag = createPushupDiagnostics();
    diag.start({ downAngle: 100 }, 0);
    diag.sample({ angle: 150, downAngle: 100 }, 10);
    diag.sample({ angle: 120, downAngle: 100 }, 20); // bent, but not past 100
    expect(diag.report.summary.downAngleReached).toBe(false);
  });

  it('tracks the most-recent rep count in the summary', () => {
    const diag = createPushupDiagnostics();
    diag.start({ downAngle: 100 }, 0);
    diag.sample({ angle: 92, downAngle: 100, reps: 0 }, 10);
    diag.sample({ angle: 158, downAngle: 100, reps: 1 }, 20);
    expect(diag.report.summary.repsCounted).toBe(1);
  });

  it('stops recording after finish() but keeps the data readable', () => {
    const diag = createPushupDiagnostics();
    diag.start({ downAngle: 100 }, 1000);
    diag.sample({ angle: 92, downAngle: 100, reps: 1 }, 1100);
    diag.finish('completed', 1500);

    expect(diag.active).toBe(false);
    // Samples after finish are ignored.
    diag.sample({ angle: 80, downAngle: 100 }, 1600);
    const { report } = diag;
    expect(report.finishReason).toBe('completed');
    expect(report.durationMs).toBe(500);
    expect(report.samples).toHaveLength(1);
    expect(report.summary.sampleCount).toBe(1);
  });

  it('caps stored samples but keeps summary stats correct for all of them', () => {
    const diag = createPushupDiagnostics();
    diag.start({ downAngle: 100 }, 0);
    // Feed more than the internal cap (400). Angles climb from 100 upward.
    for (let i = 0; i < 450; i++) {
      diag.sample({ angle: 100 + i * 0.1, downAngle: 100 }, i);
    }
    const { report } = diag;
    // Stored samples are capped...
    expect(report.samples.length).toBeLessThanOrEqual(400);
    // ...but the summary still saw every one.
    expect(report.summary.sampleCount).toBe(450);
    expect(report.summary.maxAngle).toBeCloseTo(100 + 449 * 0.1, 1);
  });

  it('reset() clears everything', () => {
    const diag = createPushupDiagnostics();
    diag.start({ downAngle: 100 }, 0);
    diag.sample({ angle: 92, downAngle: 100 }, 10);
    diag.reset();
    expect(diag.active).toBe(false);
    expect(diag.report.meta).toBe(null);
    expect(diag.report.samples).toHaveLength(0);
    expect(diag.report.summary.sampleCount).toBe(0);
  });

  it('finish() before start() is a safe no-op', () => {
    const diag = createPushupDiagnostics();
    expect(() => diag.finish('completed', 100)).not.toThrow();
    expect(diag.report.finishReason).toBe(null);
  });
});
