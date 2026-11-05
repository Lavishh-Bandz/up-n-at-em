import { describe, it, expect } from 'vitest';
import { createWorkoutQueue } from '../workoutQueue.js';

const twoStepWorkout = () => [
  { exercise: 'pushup', difficulty: 'hard', targetReps: 3 },
  { exercise: 'situp', difficulty: 'easy', targetReps: 2 },
];

describe('createWorkoutQueue', () => {
  it('throws on an empty or invalid step list', () => {
    expect(() => createWorkoutQueue([])).toThrow();
    expect(() => createWorkoutQueue(undefined)).toThrow();
  });

  it('starts on the first step', () => {
    const q = createWorkoutQueue(twoStepWorkout());
    expect(q.currentIndex()).toBe(0);
    expect(q.current().exercise).toBe('pushup');
    expect(q.length).toBe(2);
  });

  it('records reps and caps them at the step target', () => {
    const q = createWorkoutQueue(twoStepWorkout());
    q.recordRep();
    q.recordRep();
    q.recordRep();
    q.recordRep(); // 4th rep ignored, target is 3
    expect(q.current().completedReps).toBe(3);
    expect(q.isStepComplete()).toBe(true);
  });

  it('setReps clamps to the 0..target range', () => {
    const q = createWorkoutQueue(twoStepWorkout());
    expect(q.setReps(99)).toBe(3); // capped at target
    expect(q.setReps(-5)).toBe(0); // floored at 0
  });

  it('is NOT complete until every step reaches its target', () => {
    const q = createWorkoutQueue(twoStepWorkout());
    expect(q.isWorkoutComplete()).toBe(false);

    // Finish step 1 (push-ups).
    q.setReps(3);
    expect(q.isStepComplete()).toBe(true);
    // Still not done: step 2 is untouched.
    expect(q.isWorkoutComplete()).toBe(false);

    // Advance to step 2 and finish it.
    expect(q.advance()).toBe(true);
    expect(q.current().exercise).toBe('situp');
    q.setReps(2);
    expect(q.isWorkoutComplete()).toBe(true);
  });

  it('advance() walks steps in order and refuses to skip an incomplete step', () => {
    const q = createWorkoutQueue(twoStepWorkout());

    // Cannot advance while step 1 is unfinished.
    expect(q.advance()).toBe(false);
    expect(q.currentIndex()).toBe(0);

    // Finish step 1, then advance succeeds.
    q.setReps(3);
    expect(q.advance()).toBe(true);
    expect(q.currentIndex()).toBe(1);

    // No further steps: advance returns false even when the last step is done.
    q.setReps(2);
    expect(q.advance()).toBe(false);
    expect(q.currentIndex()).toBe(1);
  });

  it('snapshot() returns a read-only copy that does not mutate internals', () => {
    const q = createWorkoutQueue(twoStepWorkout());
    const snap = q.snapshot();
    snap[0].completedReps = 999;
    expect(q.current().completedReps).toBe(0);
  });
});
