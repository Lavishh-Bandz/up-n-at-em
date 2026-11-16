// armingReadyGate.test.js
// -----------------------------------------------------------------------------
// REGRESSION TESTS for the arming-countdown bug the user reported:
//
//   "the get-into-position countdown counts down WHILE I'm STANDING UP; it
//    should only count down once I'm actually down in push-up/ready position.
//    I do push-ups from the SIDE."
//
// ROOT CAUSE: WorkoutSession fed the arming gate `isConfident`, which for
// push-ups only means "the chosen-side shoulder is visible and the frame is not
// an outlier". Merely STANDING satisfied that, so the countdown advanced.
//
// THE FIX: the arming gate is now fed `isConfident && isReadyForArming(...)`.
// isReadyForArming is a side-view-friendly ready-position check that FAILS
// TOWARD NOT ARMING, so a standing body pauses the countdown.
//
// These tests wire the REAL shipped pieces together exactly the way
// WorkoutSession.handlePose feeds the arming gate for a push-up frame:
//
//   isReadyForArming(keypoints, side, ruler)  ->  armingReady
//   positionGate.update(armingReady, nowMs)   ->  armed?
//
// so we prove, end-to-end on pure logic, that:
//   (a) a STANDING side-view posture NEVER arms the gate, even after holding
//       far longer than the 5-second hold;
//   (b) a genuine READY side-view (down) posture DOES arm the gate after the
//       hold, exactly as before the fix.
//
// We use the SHIPPED readyGuard config + the SHIPPED 5s hold so the behaviour
// under test is the real one.

import { describe, it, expect } from 'vitest';
import { createPositionGate, DEFAULT_HOLD_MS } from '../positionGate.js';
import { isReadyForArming } from '../upperBodySignal.js';
import { getExercise } from '../exercises.js';

const kp = (x, y, score = 0.9) => ({ x, y, score });

// The locked-ruler-sized value a real side-view set would use. 100px keeps the
// fractions readable (a 0.5-of-scale gap is 50px).
const RULER = 100;
const READY_CONFIG = getExercise('pushup').readyGuard;

// Drive the SAME arming pipeline WorkoutSession uses: for each frame compute the
// readiness flag and feed it to the position gate with a monotonically
// increasing timestamp. 16ms frames (~60fps). Returns whether it armed within
// the given number of seconds of in-frame time.
function armAfterHolding(frame, side, seconds) {
  const gate = createPositionGate(); // default 5s hold
  const frames = Math.ceil((seconds * 1000) / 16) + 2;
  let now = 0;
  let armed = false;
  for (let i = 0; i < frames; i += 1) {
    const ready = isReadyForArming(frame, side, RULER, READY_CONFIG);
    // Mirror WorkoutSession: armingReady = isConfident && ready. The shoulder is
    // confidently visible in every frame here, so isConfident is true and the
    // readiness flag is the only thing that can pause the countdown.
    const res = gate.update(ready, now);
    armed = res.armed;
    now += 16;
  }
  return armed;
}

describe('arming countdown gate (ready-position, side-view)', () => {
  it('does NOT arm while STANDING side-on, even after holding 10 seconds', () => {
    // Standing side-on: the shoulder is stacked a full body-scale ABOVE the hip
    // (shoulder y=200, hip y=300 -> 100px = 1.0 of scale). This is exactly the
    // posture the user was in when the countdown wrongly advanced.
    const standing = {
      left_shoulder: kp(200, 200),
      left_hip: kp(205, 300),
    };
    // Sanity: the readiness check itself says NOT ready for this frame.
    expect(isReadyForArming(standing, 'left', RULER, READY_CONFIG)).toBe(false);
    // And across a long hold the gate never arms.
    expect(armAfterHolding(standing, 'left', 10)).toBe(false);
  });

  it('DOES arm a genuine side-view DOWN/ready position after the 5s hold', () => {
    // Side-on plank: shoulder and hip roughly level (20px = 0.2 of scale gap).
    const down = {
      left_shoulder: kp(200, 300),
      left_hip: kp(120, 320),
    };
    expect(isReadyForArming(down, 'left', RULER, READY_CONFIG)).toBe(true);
    // Just over the 5s hold worth of in-position frames -> armed.
    expect(armAfterHolding(down, 'left', DEFAULT_HOLD_MS / 1000 + 0.2)).toBe(
      true
    );
  });

  it('CONTROL: the identical gate arms the standing frame if readiness is forced true', () => {
    // This proves the zero-arming result above is caused by the readiness gate,
    // not by some unrelated timing bug: feed the gate a constant `true` (as the
    // OLD code effectively did with isConfident) and the same standing posture
    // arms right away. If the gate were broken this control would also fail.
    const gate = createPositionGate();
    let now = 0;
    let armed = false;
    for (let i = 0; i < 400; i += 1) {
      armed = gate.update(true, now).armed; // readiness forced true
      now += 16;
    }
    expect(armed).toBe(true);
  });

  it('PAUSES then RESUMES: standing stalls the countdown, going down finishes it', () => {
    // Hold a standing posture for a while (countdown frozen), then drop into a
    // ready posture and finish the hold. Proves the countdown resumes rather
    // than being permanently blocked, so the user is never stuck unable to arm.
    const gate = createPositionGate();
    const standing = { left_shoulder: kp(200, 200), left_hip: kp(205, 300) };
    const down = { left_shoulder: kp(200, 300), left_hip: kp(120, 320) };
    let now = 0;

    // 3 seconds standing -> no progress banked, not armed.
    for (let i = 0; i < Math.ceil(3000 / 16); i += 1) {
      const ready = isReadyForArming(standing, 'left', RULER, READY_CONFIG);
      gate.update(ready, now);
      now += 16;
    }
    expect(gate.armed).toBe(false);

    // Now drop down and hold just over the full 5s -> arms.
    for (let i = 0; i < Math.ceil(5200 / 16); i += 1) {
      const ready = isReadyForArming(down, 'left', RULER, READY_CONFIG);
      gate.update(ready, now);
      now += 16;
    }
    expect(gate.armed).toBe(true);
  });
});
