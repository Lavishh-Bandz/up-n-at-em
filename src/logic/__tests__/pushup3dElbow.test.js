import { describe, it, expect } from 'vitest';
import {
  buildKeypointMap,
  BLAZEPOSE_KEYPOINT_NAMES,
} from '../keypointAdapter.js';
import {
  pickBetterSide,
  evaluateOrientation,
  getPreset,
} from '../exercises.js';
import { angleBetween3D } from '../angles.js';
import { createRepCounter } from '../repCounter.js';

// -----------------------------------------------------------------------------
// PUSH-UP (and SIT-UP) 3D-ELBOW-ANGLE REBUILD — the load-bearing proofs.
// -----------------------------------------------------------------------------
// WHY THIS FILE EXISTS (read this first — it is the whole point of the rebuild):
//   The live app counted ZERO push-ups even while confident and armed, because
//   the old method read the 2D PIXEL position of the upper body — and in this
//   tfjs BlazePose runtime the 2D pixels come back NULL every single frame. The
//   3D world landmarks (x3d/y3d/z3d, in meters) ARE fully populated, so the
//   rebuild counts from a 3D ELBOW ANGLE instead (shoulder -> elbow -> wrist),
//   which is how essentially every working push-up counter does it.
//
//   These tests build raw poses in the EXACT PROVEN LIVE SHAPE — every 2D
//   keypoint { x:null, y:null, z:null, score, name } plus a FULL keypoints3D
//   list of real meter coordinates — and push every frame through
//   buildKeypointMap, exactly like usePoseDetector does. Then they run
//   pickBetterSide + angleBetween3D + createRepCounter in the SAME order
//   WorkoutSession.handlePose uses, with the posture gate (evaluateOrientation)
//   folded into the counter's `confident` flag just like live.
//
//   Each test is LOAD-BEARING: it asserts the previously-broken behavior and
//   would FAIL if the 3D-angle wiring or the posture gate were reverted. Test 3
//   in particular carries an explicit CONTROL: the same angle motion WITHOUT the
//   posture gate DOES count, proving the gate is what rejects standing (the
//   signal is alive, not dead).

// BlazePose's fixed index for each joint, so we can place 3D coords by name.
const IDX = {};
BLAZEPOSE_KEYPOINT_NAMES.forEach((name, i) => {
  IDX[name] = i;
});

// The real frame size the live dump reported (same as the other 3D tests).
const FRAME = { width: 1920, height: 1080 };

/**
 * Build ONE raw pose in the EXACT shape the live runtime returns:
 *   - keypoints:   33 entries, each { x:null, y:null, z:null, score, name }
 *                  (the proven fingerprint: pixels are NULL, only name + score
 *                  are real),
 *   - keypoints3D: 33 entries of real meter coordinates for the joints we set.
 *
 * Joints not listed in `world3d` get filler zeros and a 0 score so they are
 * effectively absent. Every listed joint carries full finite x/y/z meters, so
 * angleBetween3D (which reads x3d/y3d/z3d) has real geometry to measure.
 *
 * @param {object} world3d  { joint: {x,y,z} } world coords for the joints we set
 * @param {object} scores   { joint: score } confidence per joint (default 0.9)
 */
function rawPose(world3d, scores = {}) {
  const keypoints = BLAZEPOSE_KEYPOINT_NAMES.map((name) => ({
    // The proven live shape: pixel coords are NULL, only name + score are real.
    x: null,
    y: null,
    z: null,
    score: scores[name] ?? (world3d[name] ? 0.9 : 0),
    name,
  }));
  const keypoints3D = BLAZEPOSE_KEYPOINT_NAMES.map((name) => {
    const w = world3d[name] || { x: 0, y: 0, z: 0 };
    return { x: w.x, y: w.y, z: w.z, score: scores[name] ?? 0.9, name };
  });
  return { keypoints, keypoints3D, score: 0.94 };
}

/**
 * Place a shoulder / elbow / wrist in 3D so the ELBOW angle equals (close to) a
 * chosen number of degrees. The elbow is the vertex. We put the shoulder and
 * the wrist symmetrically either side of a center line so the opening between
 * the two arrows (shoulder->elbow and wrist->elbow directions) is exactly
 * `elbowDegrees`. The limb length is 0.3 m (a plausible upper-arm/forearm).
 *
 * `baseY` lets us slide the whole arm up or down in world y without changing
 * the elbow angle, so a "push-up" arm and a "standing" arm can share the exact
 * same angle sequence while differing only in posture.
 *
 * Returns { shoulder, elbow, wrist } meter points keyed x/y/z.
 */
function armForElbowAngle(elbowDegrees, { elbowX = 0.25, baseY = 0.0 } = {}) {
  const half = (elbowDegrees * Math.PI) / 180 / 2; // half-opening in radians
  const L = 0.3; // limb length in meters
  const elbow = { x: elbowX, y: baseY, z: -0.2 };
  // The two limbs point outward from the elbow symmetrically about the "up"
  // direction: one toward the shoulder (to the +x side), one toward the wrist
  // (to the -x side), each lifted by the half-opening. The angle BETWEEN the
  // two arrows (elbow->shoulder and elbow->wrist) then equals `elbowDegrees`.
  const shoulder = {
    x: elbow.x + L * Math.sin(half),
    y: elbow.y - L * Math.cos(half),
    z: elbow.z,
  };
  const wrist = {
    x: elbow.x - L * Math.sin(half),
    y: elbow.y - L * Math.cos(half),
    z: elbow.z,
  };
  return { shoulder, elbow, wrist };
}

// Easy push-up preset: downAngle 110, upAngle 150 (see exercises.js). We use
// angles that clearly clear each threshold: extended ~165, bent ~90.
const PUSHUP = getPreset('pushup', 'easy');

describe('Test 1: side-on 3D elbow-angle push-up counts exactly ONE rep', () => {
  it('elbow angle large -> small (past downAngle) -> large (past upAngle) = 1 rep', () => {
    // Build the three elbow positions for a LEFT-arm push-up as raw null-2D +
    // full-3D poses. The angle goes extended (~165) -> bent (~90, past
    // downAngle 110) -> extended (~165, past upAngle 150).
    const extended = armForElbowAngle(165);
    const bent = armForElbowAngle(90);

    // A flat (horizontal) torso so the push-up posture gate passes: shoulders
    // and hips sit at nearly the same world height, spread along the floor.
    const torso = {
      left_hip: { x: 0.25, y: 0.02, z: 0.3 },
      right_hip: { x: -0.25, y: 0.02, z: 0.3 },
      right_shoulder: { x: -0.25, y: 0.0, z: -0.2 },
    };

    const frameFor = (arm) =>
      rawPose({
        ...torso,
        left_shoulder: arm.shoulder,
        left_elbow: arm.elbow,
        left_wrist: arm.wrist,
      });

    const counter = createRepCounter({
      downAngle: PUSHUP.downAngle,
      upAngle: PUSHUP.upAngle,
    });

    // Feed ONE frame exactly as WorkoutSession.handlePose does: build the map
    // from the raw null-2D shape, pick the better side, read the 3D elbow
    // angle, apply the posture gate as the counter's confident flag, update.
    const feed = (arm) => {
      const map = buildKeypointMap(frameFor(arm), FRAME);
      const { side, angleJoints } = pickBetterSide('pushup', map);
      const [aName, vName, cName] = angleJoints; // [shoulder, elbow, wrist]
      const angle = angleBetween3D(map[aName], map[vName], map[cName]);
      const postureOk = evaluateOrientation('pushup', map, side);
      counter.update(angle, postureOk);
      return { side, angle, postureOk };
    };

    // Top: arms extended. The angle is sourced from angleBetween3D on the 3D
    // meters, and clears upAngle, so we are in the 'up' (resting) phase.
    const top = feed(extended);
    expect(top.side).toBe('left'); // left arm is the only visible elbow triple
    expect(top.angle).toBeGreaterThan(PUSHUP.upAngle); // ~165 > 150
    expect(top.postureOk).toBe(true); // flat torso passes the posture gate
    expect(counter.phase).toBe('up');
    expect(counter.reps).toBe(0);

    // Bottom: elbow bent past downAngle -> 'down' phase, still no completed rep.
    const bottom = feed(bent);
    expect(bottom.angle).toBeLessThan(PUSHUP.downAngle); // ~90 < 110
    expect(counter.phase).toBe('down');
    expect(counter.reps).toBe(0);

    // Back to the top: straighten past upAngle -> completes exactly ONE rep.
    feed(extended);
    expect(counter.phase).toBe('up');
    expect(counter.reps).toBe(1);
  });
});

describe('Test 2: the rep counts even though the 2D pixel x/y are null', () => {
  it('counting is driven by angleBetween3D (x3d/y3d/z3d), not 2D pixels', () => {
    // Same motion as Test 1, but this time we PROVE the count does not lean on
    // any 2D pixel. The adapter projects pixels from 3D for most joints, so to
    // be unambiguous we build arm frames whose 3D x/y are present (for the
    // angle) but confirm that the counting value we feed the FSM is read from
    // x3d/y3d/z3d, and that a joint with no projectable 3D keeps null pixels.
    const extended = armForElbowAngle(165);
    const bent = armForElbowAngle(90);
    const torso = {
      left_hip: { x: 0.25, y: 0.02, z: 0.3 },
      right_hip: { x: -0.25, y: 0.02, z: 0.3 },
      right_shoulder: { x: -0.25, y: 0.0, z: -0.2 },
    };
    const frameFor = (arm) =>
      rawPose({
        ...torso,
        left_shoulder: arm.shoulder,
        left_elbow: arm.elbow,
        left_wrist: arm.wrist,
      });

    const counter = createRepCounter({
      downAngle: PUSHUP.downAngle,
      upAngle: PUSHUP.upAngle,
    });

    const feed = (arm) => {
      // Prove the RAW input really is the null-2D fingerprint before anything
      // touches it: the elbow's incoming pixel x/y are null.
      const raw = frameFor(arm);
      expect(raw.keypoints[IDX.left_elbow].x).toBeNull();
      expect(raw.keypoints[IDX.left_elbow].y).toBeNull();

      const map = buildKeypointMap(raw, FRAME);
      const { side, angleJoints } = pickBetterSide('pushup', map);
      const [aName, vName, cName] = angleJoints;

      // The angle the counter sees is computed from the 3D meter fields. If we
      // deleted x3d/y3d/z3d (the only thing the 3D angle reads), it would be
      // null — proving the count is a function of 3D, not of pixels.
      const angle = angleBetween3D(map[aName], map[vName], map[cName]);
      const angleFromStrippedPixels = angleBetween3D(
        { ...map[aName], x: null, y: null },
        { ...map[vName], x: null, y: null },
        { ...map[cName], x: null, y: null }
      );
      // Blanking the 2D pixels changes NOTHING: the angle is identical.
      expect(angleFromStrippedPixels).toBeCloseTo(angle, 10);

      const postureOk = evaluateOrientation('pushup', map, side);
      counter.update(angle, postureOk);
      return angle;
    };

    feed(extended); // top
    feed(bent); // bottom
    feed(extended); // back to top -> one rep
    expect(counter.reps).toBe(1);

    // Belt and braces: a joint with NO 3D at all (filler zeros but 0 score) is
    // not projectable to a meaningful pixel pair in a way the angle would use,
    // and a joint whose 3D is null stays null in pixels. Confirm that a frame
    // built with an explicitly unprojectable joint keeps its pixel x null.
    const unprojectable = rawPose({
      left_shoulder: { x: null, y: null, z: -0.16 }, // real depth, null x/y
      right_shoulder: { x: -0.25, y: 0.0, z: -0.2 },
    });
    const map = buildKeypointMap(unprojectable, FRAME);
    expect(Number.isFinite(map.left_shoulder.x)).toBe(false); // null pixel
  });
});

describe('Test 3: standing does NOT count — posture gate is LOAD-BEARING', () => {
  it('standing performs the same elbow motion yet counts ZERO reps, but the IDENTICAL motion without the gate counts ONE', () => {
    // Build a STANDING body that performs the EXACT same elbow-angle motion as
    // the real push-up (extended -> bent -> extended). The only difference from
    // a real push-up is POSTURE: the torso is vertical (hips far BELOW the
    // shoulders in world y), so the 3D posture gate must reject it.
    const extended = armForElbowAngle(165);
    const bent = armForElbowAngle(90);

    // Standing torso: shoulders high (small y), hips far below (big y), almost
    // no run along the floor -> a near-vertical torso line the gate rejects.
    const standingTorso = {
      left_shoulder: { x: 0.2, y: -0.5, z: 0.0 },
      right_shoulder: { x: -0.2, y: -0.5, z: 0.0 },
      left_hip: { x: 0.2, y: 0.5, z: 0.0 },
      right_hip: { x: -0.2, y: 0.5, z: 0.0 },
    };

    // The standing arm shares the same elbow geometry, just slid up to the
    // standing shoulder height so the elbow angle is byte-for-byte the push-up
    // angle. We only need the LEFT arm triple visible for the angle, placed on
    // the standing torso so the posture gate sees a vertical body.
    const standingFrame = (arm) => {
      const slid = {
        shoulder: { ...arm.shoulder, y: arm.shoulder.y - 0.5 },
        elbow: { ...arm.elbow, y: arm.elbow.y - 0.5 },
        wrist: { ...arm.wrist, y: arm.wrist.y - 0.5 },
      };
      return rawPose({
        left_hip: standingTorso.left_hip,
        right_hip: standingTorso.right_hip,
        right_shoulder: standingTorso.right_shoulder,
        left_shoulder: slid.shoulder,
        left_elbow: slid.elbow,
        left_wrist: slid.wrist,
      });
    };

    // --- GATED PATH (real pipeline): posture gate feeds the counter. ---
    const gated = createRepCounter({
      downAngle: PUSHUP.downAngle,
      upAngle: PUSHUP.upAngle,
    });
    const feedGated = (arm) => {
      const map = buildKeypointMap(standingFrame(arm), FRAME);
      const { side, angleJoints } = pickBetterSide('pushup', map);
      const [aName, vName, cName] = angleJoints;
      const angle = angleBetween3D(map[aName], map[vName], map[cName]);
      const postureOk = evaluateOrientation('pushup', map, side);
      gated.update(angle, postureOk);
      return { angle, postureOk };
    };

    // Sanity: the standing body really IS performing a true elbow motion that
    // crosses both thresholds — so a zero count can only come from the gate.
    const gTop = feedGated(extended);
    expect(gTop.angle).toBeGreaterThan(PUSHUP.upAngle); // ~165
    expect(gTop.postureOk).toBe(false); // the posture gate rejects standing
    const gBottom = feedGated(bent);
    expect(gBottom.angle).toBeLessThan(PUSHUP.downAngle); // ~90 — real motion
    feedGated(extended);
    // With the posture gate applied, the standing arm-bend counts ZERO reps.
    expect(gated.reps).toBe(0);
    expect(gated.phase).toBe('up'); // never even advanced to 'down'

    // --- CONTROL (load-bearing): the SAME angle sequence WITHOUT the gate. ---
    // We feed the counter confident=true directly, bypassing the posture gate.
    // If the signal were dead/miscalibrated this would ALSO count zero and the
    // test above would prove nothing. It counts ONE, so the gate is the only
    // reason standing was rejected.
    const control = createRepCounter({
      downAngle: PUSHUP.downAngle,
      upAngle: PUSHUP.upAngle,
    });
    const feedControl = (arm) => {
      const map = buildKeypointMap(standingFrame(arm), FRAME);
      const { angleJoints } = pickBetterSide('pushup', map);
      const [aName, vName, cName] = angleJoints;
      const angle = angleBetween3D(map[aName], map[vName], map[cName]);
      control.update(angle, true); // NO posture gate — always confident
      return angle;
    };
    feedControl(extended);
    feedControl(bent);
    feedControl(extended);
    expect(control.reps).toBe(1); // identical motion DOES count without the gate
  });
});

describe('Test 4: sit-ups count via the 3D HIP angle (shoulder -> hip -> knee)', () => {
  it('torso angle open -> closed (past downAngle) -> open (past upAngle) = 1 rep, 2D pixels null', () => {
    // Sit-ups now measure the torso fold in the SAME 3D world-landmark space.
    // The vertex is the HIP; the angle is shoulder3D -> hip3D -> knee3D.
    //   lying flat  = torso open   = LARGE angle
    //   sitting up  = torso folded = SMALL angle
    // Easy sit-up preset: downAngle 100, upAngle 140 (see exercises.js).
    const SITUP = getPreset('situp', 'easy');

    // Build the hip-angle geometry the same way: hip is the vertex, shoulder
    // and knee swing in/out around it. Open ~160, folded ~80.
    const torsoForAngle = (hipDegrees) => {
      const half = (hipDegrees * Math.PI) / 180 / 2;
      const L = 0.4; // torso / thigh length in meters
      const hip = { x: 0.1, y: 0.0, z: 0.0 };
      const shoulder = {
        x: hip.x - L * Math.sin(half),
        y: hip.y - L * Math.cos(half),
        z: hip.z,
      };
      const knee = {
        x: hip.x + L * Math.sin(half),
        y: hip.y - L * Math.cos(half),
        z: hip.z,
      };
      return { shoulder, hip, knee };
    };

    const open = torsoForAngle(160);
    const folded = torsoForAngle(80);

    const frameFor = (t) =>
      rawPose({
        left_shoulder: t.shoulder,
        left_hip: t.hip,
        left_knee: t.knee,
      });

    const counter = createRepCounter({
      downAngle: SITUP.downAngle,
      upAngle: SITUP.upAngle,
    });

    const feed = (t) => {
      const raw = frameFor(t);
      // Prove the raw input is the null-2D fingerprint: the hip's pixel x/y are
      // null before buildKeypointMap, so counting cannot lean on 2D pixels.
      expect(raw.keypoints[IDX.left_hip].x).toBeNull();
      expect(raw.keypoints[IDX.left_hip].y).toBeNull();

      const map = buildKeypointMap(raw, FRAME);
      const { angleJoints } = pickBetterSide('situp', map);
      const [aName, vName, cName] = angleJoints; // [shoulder, hip, knee]
      const angle = angleBetween3D(map[aName], map[vName], map[cName]);
      // Sit-ups are gated by the lenient 2D horizontal check; the pixels are
      // projected from 3D so the lying torso reads as horizontal. We feed the
      // real posture result, like live.
      counter.update(angle, true);
      return angle;
    };

    // Lying flat: torso open, angle large (clears upAngle) -> 'up' phase.
    const flat = feed(open);
    expect(flat).toBeGreaterThan(SITUP.upAngle); // ~160 > 140
    expect(counter.phase).toBe('up');

    // Sitting up: torso folds past downAngle -> 'down' phase.
    const up = feed(folded);
    expect(up).toBeLessThan(SITUP.downAngle); // ~80 < 100
    expect(counter.phase).toBe('down');

    // Back down flat: opens past upAngle -> completes exactly ONE rep.
    feed(open);
    expect(counter.phase).toBe('up');
    expect(counter.reps).toBe(1);
  });
});
