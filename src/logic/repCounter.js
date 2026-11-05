// repCounter.js
// -----------------------------------------------------------------------------
// A tiny finite state machine (FSM) that counts repetitions of an exercise by
// watching a single joint angle go DOWN and then back UP.
//
// It is a PURE module: you feed it one angle reading at a time and it returns
// the current phase. No timers, no DOM, no webcam. That makes it trivial to
// unit test (just call update() with made-up numbers) and reusable anywhere.
//
// WHY A STATE MACHINE WITH TWO THRESHOLDS (HYSTERESIS)?
//   Imagine a push-up where the elbow angle wobbles around 150 degrees at the
//   top. If we counted a rep every time the angle crossed a single line, that
//   tiny jitter would rack up dozens of fake reps.
//
//   Instead we use TWO lines with a gap between them:
//     downAngle (lower)  -> you must bend PAST this to reach the "down" phase
//     upAngle   (higher) -> you must straighten PAST this to complete the rep
//
//   Because downAngle < upAngle, small wobbles that stay inside the gap do not
//   change anything. You have to make a real, full movement to toggle phases.
//   This gap is the "hysteresis band".
//
// THE PHASES:
//   'up'   = starting/resting position (e.g. arms straight)
//   'down' = you have reached the bottom of the movement (e.g. elbow bent)
//
// A rep is counted on the transition down -> up (you went all the way down and
// then all the way back up). One full cycle = one rep.
//
// ANTI-CHEAT:
//   update(angle, confident) takes a `confident` flag. If the relevant joints
//   are not clearly visible (confident === false), we DO NOT advance the state
//   machine at all. You cannot earn reps the camera cannot actually verify.

/**
 * Create a rep counter.
 *
 * @param {object} options
 * @param {number} options.downAngle      Bend past this (angle <= downAngle) to
 *                                         enter the 'down' phase. The smaller/
 *                                         deeper number of the pair.
 * @param {number} options.upAngle         Straighten past this (angle >= upAngle)
 *                                         while 'down' to complete a rep. The
 *                                         larger number of the pair.
 * @param {number} [options.minConfidence] Kept for callers that want to remember
 *                                         the threshold alongside the counter.
 *                                         The FSM itself trusts the `confident`
 *                                         flag passed to update().
 * @returns {{
 *   update: (angle:number, confident:boolean) => ('up'|'down'),
 *   reset: () => void,
 *   get reps: () => number,
 *   get phase: () => ('up'|'down')
 * }}
 */
export function createRepCounter({ downAngle, upAngle, minConfidence = 0.3 } = {}) {
  // Guard against a misconfiguration that would break the hysteresis idea.
  if (!(downAngle < upAngle)) {
    throw new Error(
      `repCounter requires downAngle < upAngle (got downAngle=${downAngle}, upAngle=${upAngle})`
    );
  }

  // Private state. Everyone starts in the 'up' (resting) position with 0 reps.
  let phase = 'up';
  let reps = 0;

  return {
    // Expose the config in case the UI wants to show it. Not used by the FSM.
    minConfidence,

    /**
     * Feed one angle reading into the machine.
     *
     * @param {number} angle      The measured joint angle in degrees.
     * @param {boolean} confident Whether the joints were clearly visible.
     * @returns {'up'|'down'} the phase after processing this reading.
     */
    update(angle, confident) {
      // ANTI-CHEAT GATE: ignore readings we cannot trust. The phase and rep
      // count are left exactly as they were.
      if (!confident) {
        return phase;
      }

      if (phase === 'up') {
        // Waiting for you to go DOWN. Bending past downAngle starts the rep.
        if (angle <= downAngle) {
          phase = 'down';
        }
      } else {
        // phase === 'down': waiting for you to come back UP.
        // Straightening past upAngle completes one full rep.
        if (angle >= upAngle) {
          phase = 'up';
          reps += 1;
        }
      }

      return phase;
    },

    /** Reset back to the starting state (0 reps, 'up' phase). */
    reset() {
      phase = 'up';
      reps = 0;
    },

    /** Current number of completed reps. */
    get reps() {
      return reps;
    },

    /** Current phase: 'up' or 'down'. */
    get phase() {
      return phase;
    },
  };
}
