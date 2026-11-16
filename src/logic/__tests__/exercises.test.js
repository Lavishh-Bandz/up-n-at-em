import { describe, it, expect } from 'vitest';
import {
  EXERCISES,
  DIFFICULTIES,
  getExercise,
  getPreset,
  sumSideConfidence,
  pickBetterSide,
  evaluateOrientation,
} from '../exercises.js';

describe('exercise descriptors', () => {
  it('defines pushup and situp', () => {
    expect(getExercise('pushup').id).toBe('pushup');
    expect(getExercise('situp').id).toBe('situp');
  });

  it('throws on an unknown exercise', () => {
    expect(() => getExercise('backflip')).toThrow();
  });

  it('tracks push-ups by the 3D ELBOW angle (shoulder -> elbow -> wrist), both sides', () => {
    // Push-ups are now ANGLE-based, like every working push-up counter: we
    // measure the ELBOW angle (shoulder -> elbow -> wrist) and watch it bend
    // down and straighten up. The joints are listed vertex-in-the-middle
    // (elbow is the corner angleBetween3D measures), exactly like sit-ups.
    expect(EXERCISES.pushup.sides.left.angleJoints).toEqual([
      'left_shoulder',
      'left_elbow',
      'left_wrist',
    ]);
    expect(EXERCISES.pushup.sides.right.angleJoints).toEqual([
      'right_shoulder',
      'right_elbow',
      'right_wrist',
    ]);
  });

  it('uses MoveNet keypoint names for the sit-up tracked angle joints (both sides)', () => {
    // Sit-up tracks the hip/torso angle: shoulder -> hip -> knee, per side.
    expect(EXERCISES.situp.sides.left.angleJoints).toEqual([
      'left_shoulder',
      'left_hip',
      'left_knee',
    ]);
    expect(EXERCISES.situp.sides.right.angleJoints).toEqual([
      'right_shoulder',
      'right_hip',
      'right_knee',
    ]);
  });

  it('lists required keypoints for anti-cheat pose validation (both sides)', () => {
    // Push-ups now require the SHOULDER, ELBOW and WRIST on the chosen side —
    // the exact three joints the elbow angle is built from. The angle cannot be
    // measured without all three, so all three must be confidently visible.
    expect(EXERCISES.pushup.sides.left.requiredKeypoints).toEqual([
      'left_shoulder',
      'left_elbow',
      'left_wrist',
    ]);
    expect(EXERCISES.pushup.sides.right.requiredKeypoints).toEqual([
      'right_shoulder',
      'right_elbow',
      'right_wrist',
    ]);
    // The elbow and wrist are now REQUIRED (the angle depends on them).
    for (const side of ['left', 'right']) {
      expect(EXERCISES.pushup.sides[side].requiredKeypoints).toContain(`${side}_elbow`);
      expect(EXERCISES.pushup.sides[side].requiredKeypoints).toContain(`${side}_wrist`);
    }
    // Sit-ups are unchanged: they still require the hip.
    expect(EXERCISES.situp.sides.left.requiredKeypoints).toContain('left_hip');
    expect(EXERCISES.situp.sides.right.requiredKeypoints).toContain('right_hip');
  });

  it('exposes all three sit-up difficulty presets as angles', () => {
    for (const difficulty of DIFFICULTIES) {
      const preset = getPreset('situp', difficulty);
      expect(typeof preset.downAngle).toBe('number');
      expect(typeof preset.upAngle).toBe('number');
      expect(typeof preset.defaultReps).toBe('number');
      // Hysteresis must hold for every sit-up preset.
      expect(preset.downAngle).toBeLessThan(preset.upAngle);
    }
  });

  it('exposes all three push-up difficulty presets as elbow angles', () => {
    for (const difficulty of DIFFICULTIES) {
      const preset = getPreset('pushup', difficulty);
      // Push-ups are angle-based now, so the presets are ELBOW ANGLES fed to
      // createRepCounter (bend PAST downAngle, straighten PAST upAngle).
      expect(typeof preset.downAngle).toBe('number');
      expect(typeof preset.upAngle).toBe('number');
      expect(typeof preset.defaultReps).toBe('number');
      // Hysteresis must hold: the "down" (bent) angle is the smaller number.
      expect(preset.downAngle).toBeLessThan(preset.upAngle);
      // No stale fraction fields linger from the retired position method.
      expect(preset.downFraction).toBeUndefined();
      expect(preset.upFraction).toBeUndefined();
    }
  });
});

describe('difficulty scaling', () => {
  it('makes hard stricter than easy for push-ups (deeper bend, straighter lockout, more reps)', () => {
    const easy = getPreset('pushup', 'easy');
    const standard = getPreset('pushup', 'standard');
    const hard = getPreset('pushup', 'hard');

    // Harder = a DEEPER elbow bend to reach the bottom, which is a SMALLER
    // downAngle (you must bend further before it counts you as "down").
    expect(hard.downAngle).toBeLessThan(easy.downAngle);
    expect(standard.downAngle).toBeLessThan(easy.downAngle);
    expect(hard.downAngle).toBeLessThan(standard.downAngle);
    // Harder also demands a STRAIGHTER lockout at the top: a BIGGER upAngle.
    expect(hard.upAngle).toBeGreaterThan(easy.upAngle);
    expect(hard.upAngle).toBeGreaterThan(standard.upAngle);
    // Hard asks for more reps. defaultReps is unchanged from the old presets.
    expect(hard.defaultReps).toBeGreaterThan(easy.defaultReps);
    expect(easy.defaultReps).toBe(10);
    expect(standard.defaultReps).toBe(20);
    expect(hard.defaultReps).toBe(45);
  });

  it('makes hard stricter than easy for sit-ups too', () => {
    const easy = getPreset('situp', 'easy');
    const hard = getPreset('situp', 'hard');

    expect(hard.downAngle).toBeLessThan(easy.downAngle);
    expect(hard.upAngle).toBeGreaterThan(easy.upAngle);
    expect(hard.defaultReps).toBeGreaterThan(easy.defaultReps);
  });

  it('throws on an unknown difficulty', () => {
    expect(() => getPreset('pushup', 'nightmare')).toThrow();
  });
});

describe('sumSideConfidence', () => {
  it('adds up the scores of the listed joints', () => {
    const keypoints = {
      left_shoulder: { score: 0.5 },
      left_elbow: { score: 0.4 },
      left_wrist: { score: 0.3 },
    };
    expect(
      sumSideConfidence(keypoints, ['left_shoulder', 'left_elbow', 'left_wrist'])
    ).toBeCloseTo(1.2, 5);
  });

  it('treats missing or scoreless keypoints as 0', () => {
    const keypoints = {
      left_shoulder: { score: 0.5 },
      // left_elbow missing entirely
      left_wrist: { x: 1, y: 2 }, // present but no score
    };
    expect(
      sumSideConfidence(keypoints, ['left_shoulder', 'left_elbow', 'left_wrist'])
    ).toBeCloseTo(0.5, 5);
  });

  it('returns 0 for invalid input', () => {
    expect(sumSideConfidence(null, ['left_hip'])).toBe(0);
    expect(sumSideConfidence({}, null)).toBe(0);
  });
});

describe('pickBetterSide', () => {
  it('picks the better-visible ELBOW side for push-ups and returns the angle triple', () => {
    // Push-ups now choose the side whose shoulder/elbow/wrist the camera sees
    // best (the joints the elbow angle is built from). The right arm is clearly
    // visible, the left is barely there.
    const keypoints = {
      left_shoulder: { score: 0.1 },
      left_elbow: { score: 0.1 },
      left_wrist: { score: 0.1 },
      right_shoulder: { score: 0.9 },
      right_elbow: { score: 0.9 },
      right_wrist: { score: 0.9 },
    };
    const result = pickBetterSide('pushup', keypoints);
    expect(result.side).toBe('right');
    // Push-ups are angle-based now, so angleJoints is the shoulder/elbow/wrist
    // triple (NOT null) and requiredKeypoints is that same triple.
    expect(result.angleJoints).toEqual([
      'right_shoulder',
      'right_elbow',
      'right_wrist',
    ]);
    expect(result.requiredKeypoints).toEqual([
      'right_shoulder',
      'right_elbow',
      'right_wrist',
    ]);
    expect(result.rightScore).toBeGreaterThan(result.leftScore);
  });

  it('picks the left side when the left joints are more visible', () => {
    const keypoints = {
      left_shoulder: { score: 0.9 },
      left_hip: { score: 0.9 },
      left_knee: { score: 0.9 },
      right_shoulder: { score: 0.2 },
      right_hip: { score: 0.1 },
      right_knee: { score: 0.1 },
    };
    const result = pickBetterSide('situp', keypoints);
    expect(result.side).toBe('left');
    expect(result.angleJoints).toEqual([
      'left_shoulder',
      'left_hip',
      'left_knee',
    ]);
  });

  it('defaults to the left side on a tie (including nothing visible)', () => {
    // No keypoints at all: both sides score 0, so we fall back to the left.
    const result = pickBetterSide('pushup', {});
    expect(result.side).toBe('left');
    expect(result.leftScore).toBe(0);
    expect(result.rightScore).toBe(0);
  });
});

describe('exercise orientation descriptors', () => {
  it('push-ups gate on the 3D push-up posture (torso roughly horizontal)', () => {
    // 'pushup3d' on purpose: the elbow angle alone would count a standing
    // arm-bend as a rep, so push-ups now gate on a coarse 3D posture check
    // (isPushupPosture3D) that rejects a near-vertical standing torso. The
    // tilt tolerance lives on the descriptor so it can be tuned live.
    expect(EXERCISES.pushup.orientation).toBe('pushup3d');
    expect(typeof EXERCISES.pushup.postureMaxTiltDegrees).toBe('number');
    expect(EXERCISES.pushup.postureMaxTiltDegrees).toBeGreaterThan(0);
  });

  it('sit-ups use a lenient horizontal sanity check', () => {
    expect(EXERCISES.situp.orientation).toBe('horizontal');
    expect(EXERCISES.situp.orientationMaxTiltDegrees).toBeGreaterThan(45);
  });
});

describe('evaluateOrientation', () => {
  // SIT-UPS still use the lenient horizontal gate, so we exercise that behavior
  // through sit-ups (push-ups no longer gate on orientation at all).
  it('passes a sit-up when the body is horizontal', () => {
    // Shoulder and hip at the same height (lying down).
    const keypoints = {
      left_shoulder: { x: 100, y: 300, score: 0.9 },
      left_hip: { x: 300, y: 305, score: 0.9 },
    };
    expect(evaluateOrientation('situp', keypoints, 'left')).toBe(true);
  });

  it('rejects a sit-up when the body is fully standing upright', () => {
    // Shoulder high, hip far below: an upright standing torso. Even the lenient
    // sit-up tilt threshold (75 degrees) rejects a near-vertical torso.
    const keypoints = {
      left_shoulder: { x: 100, y: 100, score: 0.9 },
      left_hip: { x: 108, y: 350, score: 0.9 },
    };
    expect(evaluateOrientation('situp', keypoints, 'left')).toBe(false);
  });

  it('does not block a sit-up when the shoulder or hip is missing', () => {
    expect(evaluateOrientation('situp', { left_shoulder: { x: 1, y: 1 } }, 'left')).toBe(true);
    expect(evaluateOrientation('situp', {}, 'left')).toBe(true);
  });

  // PUSH-UPS now gate on the 3D posture: a flat (horizontal) 3D torso passes,
  // an upright (vertical) 3D torso is rejected, and missing 3D fails open so a
  // dropped keypoint never silently blocks a real rep.
  it('passes a push-up when the 3D torso is roughly horizontal (plank)', () => {
    // A plank: shoulders and hips sit at nearly the same world HEIGHT (y3d),
    // spread out along the floor (x3d). The torso line is nearly flat.
    const plank = {
      left_shoulder: { x3d: 0.3, y3d: 0.0, z3d: -0.2, score: 0.9 },
      right_shoulder: { x3d: -0.3, y3d: 0.0, z3d: -0.2, score: 0.9 },
      left_hip: { x3d: 0.3, y3d: 0.02, z3d: 0.3, score: 0.9 },
      right_hip: { x3d: -0.3, y3d: 0.02, z3d: 0.3, score: 0.9 },
    };
    expect(evaluateOrientation('pushup', plank, 'left')).toBe(true);
  });

  it('rejects a push-up when the 3D torso is standing upright (vertical)', () => {
    // Standing: the hips sit far BELOW the shoulders in world y (a big vertical
    // drop) with almost no run along the floor. The torso line is near-vertical.
    const standing = {
      left_shoulder: { x3d: 0.2, y3d: -0.5, z3d: 0.0, score: 0.9 },
      right_shoulder: { x3d: -0.2, y3d: -0.5, z3d: 0.0, score: 0.9 },
      left_hip: { x3d: 0.2, y3d: 0.5, z3d: 0.0, score: 0.9 },
      right_hip: { x3d: -0.2, y3d: 0.5, z3d: 0.0, score: 0.9 },
    };
    expect(evaluateOrientation('pushup', standing, 'left')).toBe(false);
  });

  it('does not block a push-up when the 3D torso landmarks are missing (fails open)', () => {
    // No usable 3D shoulder/hip to build a torso line: fail open (return true)
    // so a dropped keypoint never silently blocks a real rep — the confidence
    // gate handles "we cannot see you".
    expect(evaluateOrientation('pushup', { left_shoulder: { score: 0.9 } }, 'left')).toBe(true);
    expect(evaluateOrientation('pushup', {}, 'left')).toBe(true);
  });
});

describe('push-up anti-cheat: elbow-angle requirements', () => {
  // Push-ups are counted from the 3D ELBOW angle (shoulder -> elbow -> wrist),
  // so the descriptor must REQUIRE that whole triple (the angle cannot be
  // measured without all three), and a standing/upright body must be rejected
  // by the 3D posture gate.
  it('requires the shoulder, elbow AND wrist on either side (the angle triple)', () => {
    for (const side of ['left', 'right']) {
      const required = EXERCISES.pushup.sides[side].requiredKeypoints;
      expect(required).toEqual([
        `${side}_shoulder`,
        `${side}_elbow`,
        `${side}_wrist`,
      ]);
    }
  });

  it('carries the 3D posture-gate tilt tolerance as pure data on the descriptor', () => {
    // The posture tolerance lives on the push-up descriptor so it is easy to
    // find and tune live. It is a positive number of degrees (how far the 3D
    // torso line may tilt from flat and still read as a push-up / plank).
    expect(typeof EXERCISES.pushup.postureMaxTiltDegrees).toBe('number');
    expect(EXERCISES.pushup.postureMaxTiltDegrees).toBeGreaterThan(0);
    // The retired 2D posture-guard config must be gone.
    expect(EXERCISES.pushup.postureGuard).toBeUndefined();
    // Sit-ups do not carry a push-up posture tilt.
    expect(EXERCISES.situp.postureMaxTiltDegrees).toBeUndefined();
  });

  it('uses field-standard STARTING elbow angles with correct hysteresis ordering', () => {
    // Field survey: a bent elbow is ~90-110 deg at the bottom, an extended arm
    // ~150-160 deg at the top. The starting presets must sit in that ballpark
    // and keep downAngle < upAngle so the hysteresis band is real.
    for (const difficulty of DIFFICULTIES) {
      const preset = getPreset('pushup', difficulty);
      expect(preset.downAngle).toBeGreaterThanOrEqual(80);
      expect(preset.downAngle).toBeLessThan(preset.upAngle);
      expect(preset.upAngle).toBeLessThanOrEqual(170);
    }
  });

  it('pickBetterSide + evaluateOrientation keep counting unblocked when the 3D torso is missing', () => {
    // A frame with only the chosen arm's angle joints visible (hips out of
    // frame, so the 3D torso line cannot be built). pickBetterSide returns the
    // elbow-angle triple, and the posture gate fails open (does not block).
    const frame = {
      right_shoulder: { x: 400, y: 200, score: 0.9 },
      right_elbow: { x: 410, y: 260, score: 0.9 },
      right_wrist: { x: 420, y: 320, score: 0.9 },
    };
    const { side, requiredKeypoints } = pickBetterSide('pushup', frame);
    expect(side).toBe('right');
    expect(requiredKeypoints).toEqual([
      'right_shoulder',
      'right_elbow',
      'right_wrist',
    ]);
    // No 3D hip/shoulder torso line -> posture gate fails open, counting can
    // proceed (the confidence gate handles "we cannot see you").
    expect(evaluateOrientation('pushup', frame, side)).toBe(true);
  });
});
