// pushupDiagnostics.test.js
// Pure unit tests for the "click Begin -> leave a report" diagnostics recorder.
import { describe, it, expect } from 'vitest';
import { createPushupDiagnostics } from '../pushupDiagnostics.js';

describe('createPushupDiagnostics', () => {
  it('is inactive until start() and ignores samples before start', () => {
    const diag = createPushupDiagnostics();
    expect(diag.active).toBe(false);
    diag.sample({ excursion: 0.5, downFraction: 0.16 }, 100);
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
        downFraction: 0.16,
        upFraction: 0.06,
        side: 'left',
      },
      1000
    );
    expect(diag.active).toBe(true);

    diag.sample(
      {
        excursion: 0.1,
        downFraction: 0.16,
        upFraction: 0.06,
        bodyScalePx: 142.6,
        bodyScaleLocked: true,
        upperBodyY: 233.4,
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
    expect(report.meta.downFraction).toBe(0.16);
    expect(report.samples).toHaveLength(1);
    const s = report.samples[0];
    // Timestamps are stored relative to start and rounded.
    expect(s.tMs).toBe(50);
    expect(s.bodyScalePx).toBe(143); // rounded to whole px
    expect(s.upperBodyY).toBe(233);
    expect(s.bodyScaleLocked).toBe(true);
    expect(s.phase).toBe('up');
  });

  it('tracks min/max/last excursion and whether downFraction was reached', () => {
    const diag = createPushupDiagnostics();
    diag.start({ downFraction: 0.16, upFraction: 0.06 }, 0);
    diag.sample({ excursion: 0.02, downFraction: 0.16 }, 10);
    diag.sample({ excursion: 0.2, downFraction: 0.16 }, 20); // reaches down
    diag.sample({ excursion: 0.05, downFraction: 0.16 }, 30);

    const { summary } = diag.report;
    expect(summary.sampleCount).toBe(3);
    expect(summary.minExcursion).toBe(0.02);
    expect(summary.maxExcursion).toBe(0.2);
    expect(summary.lastExcursion).toBe(0.05);
    expect(summary.downFractionReached).toBe(true);
  });

  it('reports downFractionReached=false when the dip never gets deep enough', () => {
    const diag = createPushupDiagnostics();
    diag.start({ downFraction: 0.16 }, 0);
    diag.sample({ excursion: 0.05, downFraction: 0.16 }, 10);
    diag.sample({ excursion: 0.1, downFraction: 0.16 }, 20);
    expect(diag.report.summary.downFractionReached).toBe(false);
  });

  it('tracks the most-recent rep count in the summary', () => {
    const diag = createPushupDiagnostics();
    diag.start({ downFraction: 0.16 }, 0);
    diag.sample({ excursion: 0.2, downFraction: 0.16, reps: 0 }, 10);
    diag.sample({ excursion: 0.02, downFraction: 0.16, reps: 1 }, 20);
    expect(diag.report.summary.repsCounted).toBe(1);
  });

  it('stops recording after finish() but keeps the data readable', () => {
    const diag = createPushupDiagnostics();
    diag.start({ downFraction: 0.16 }, 1000);
    diag.sample({ excursion: 0.2, downFraction: 0.16, reps: 1 }, 1100);
    diag.finish('completed', 1500);

    expect(diag.active).toBe(false);
    // Samples after finish are ignored.
    diag.sample({ excursion: 0.9, downFraction: 0.16 }, 1600);
    const { report } = diag;
    expect(report.finishReason).toBe('completed');
    expect(report.durationMs).toBe(500);
    expect(report.samples).toHaveLength(1);
    expect(report.summary.sampleCount).toBe(1);
  });

  it('caps stored samples but keeps summary stats correct for all of them', () => {
    const diag = createPushupDiagnostics();
    diag.start({ downFraction: 0.16 }, 0);
    // Feed more than the internal cap (400).
    for (let i = 0; i < 450; i++) {
      diag.sample({ excursion: 0.01 + i * 0.001, downFraction: 0.16 }, i);
    }
    const { report } = diag;
    // Stored samples are capped...
    expect(report.samples.length).toBeLessThanOrEqual(400);
    // ...but the summary still saw every one.
    expect(report.summary.sampleCount).toBe(450);
    expect(report.summary.maxExcursion).toBeCloseTo(0.01 + 449 * 0.001, 3);
  });

  it('reset() clears everything', () => {
    const diag = createPushupDiagnostics();
    diag.start({ downFraction: 0.16 }, 0);
    diag.sample({ excursion: 0.2, downFraction: 0.16 }, 10);
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
