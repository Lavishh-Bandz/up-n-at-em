// DebugReadout.jsx
// -----------------------------------------------------------------------------
// The primary deliverable of this fix pass: a small, always-on, UNOBTRUSIVE
// on-screen panel showing the EXACT numbers the push-up detector used this
// frame, so the user can read them back to us and we can tune the thresholds
// from real data instead of guessing.
//
// Push-ups are counted from the 3D ELBOW JOINT ANGLE (shoulder -> elbow ->
// wrist, in degrees) through an up/down state machine, so this panel shows the
// live elbow angle next to the two angle thresholds it is working between: the
// user bends the elbow PAST the "down" threshold (angle <= downAngle) to reach
// the bottom of a push-up, then straightens PAST the "up" threshold
// (angle >= upAngle) to complete the rep. Showing the live angle and both
// thresholds side by side makes it obvious at a glance whether a real push-up
// is actually moving the angle far enough.
//
// It is a "dumb" presentational component. WorkoutSession owns the per-frame
// pipeline and feeds this component THROTTLED values via `debug` (updated only a
// few times a second, behind guarded change-checks) so this panel can never
// re-render at frame rate or flicker. If `debug` is null (e.g. sit-up step) we
// render nothing.
//
// It also shows the "click Begin -> leave a report" diagnostics: an expandable
// text block containing the full report JSON, so the user can copy it back to
// us without a webcam in front of the agent.

import { useState } from 'react';

// Format a number for display, showing a dash for missing values.
function fmt(n, decimals = 1) {
  if (typeof n !== 'number' || !Number.isFinite(n)) {
    return '—';
  }
  return n.toFixed(decimals);
}

// Format an angle in degrees (e.g. "132°"), dash for missing values.
function fmtDeg(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) {
    return '—';
  }
  return `${n.toFixed(0)}°`;
}

export default function DebugReadout({ debug, report }) {
  const [reportOpen, setReportOpen] = useState(false);

  // No push-up debug data this frame (e.g. a sit-up step): show nothing.
  if (!debug) {
    return null;
  }

  const {
    angle, // smoothed elbow angle (degrees) the counter actually saw this frame
    rawAngle, // pre-smoothing elbow angle (for comparison)
    downAngle, // bend PAST this (angle <= downAngle) to reach the bottom
    upAngle, // straighten PAST this (angle >= upAngle) to complete the rep
    confident,
    armed,
    phase,
    postureOk,
    reps,
  } = debug;

  return (
    <div className="debug-readout" aria-label="Detector debug readout">
      <div className="debug-readout-title">Detector debug (elbow angle)</div>

      {/* The single most important line: the live elbow angle in degrees. For a
          rep, the angle must bend DOWN past downAngle, then rise UP past
          upAngle. */}
      <div className="debug-line">
        elbow angle (smoothed): <strong>{fmtDeg(angle)}</strong>
      </div>
      <div className="debug-line">raw elbow angle: {fmtDeg(rawAngle)}</div>
      {/* Show the angle next to BOTH thresholds so it is obvious whether a real
          push-up is moving it far enough in each direction. */}
      <div className="debug-line">
        down ≤ {fmt(downAngle, 0)}° · up ≥ {fmt(upAngle, 0)}°
      </div>
      <div className="debug-line">confident: {confident ? 'yes' : 'no'}</div>
      <div className="debug-line">armed: {armed ? 'yes' : 'no'}</div>
      <div className="debug-line">phase: {phase ?? '—'}</div>
      <div className="debug-line">
        posture: {postureOk ? 'ok' : 'standing'}
      </div>
      <div className="debug-line">reps: {reps ?? 0}</div>

      {report && (
        <div className="debug-report">
          <button
            type="button"
            className="debug-report-toggle"
            onClick={() => setReportOpen((o) => !o)}
          >
            {reportOpen ? '▾ Hide report' : '▸ Show report'} (
            {report.summary ? report.summary.sampleCount : 0} samples)
          </button>
          {reportOpen && (
            <textarea
              className="debug-report-text"
              readOnly
              value={JSON.stringify(report, null, 2)}
              onFocus={(e) => e.target.select()}
            />
          )}
        </div>
      )}
    </div>
  );
}
