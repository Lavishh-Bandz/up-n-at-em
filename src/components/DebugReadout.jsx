// DebugReadout.jsx
// -----------------------------------------------------------------------------
// The primary deliverable of this fix pass: a small, always-on, UNOBTRUSIVE
// on-screen panel showing the EXACT numbers the push-up detector used this
// frame, so the user can read them back to us and we can tune the thresholds
// from real data instead of guessing.
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
function fmt(n, decimals = 3) {
  if (typeof n !== 'number' || !Number.isFinite(n)) {
    return '—';
  }
  return n.toFixed(decimals);
}

function fmtPx(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) {
    return '—';
  }
  return `${Math.round(n)}px`;
}

export default function DebugReadout({ debug, report }) {
  const [reportOpen, setReportOpen] = useState(false);

  // No push-up debug data this frame (e.g. a sit-up step): show nothing.
  if (!debug) {
    return null;
  }

  const {
    excursion, // smoothed dip the counter actually saw this frame
    rawExcursion, // pre-smoothing dip (for comparison)
    downFraction, // the threshold the dip must reach to go 'down'
    upFraction, // the threshold it must rise back past to complete a rep
    bodyScalePx, // the ruler actually used (locked once armed)
    bodyScaleLocked,
    upperBodyY, // raw upper-body y (pixels)
    confident,
    armed,
    phase,
    postureOk,
    reps,
  } = debug;

  return (
    <div className="debug-readout" aria-label="Detector debug readout">
      <div className="debug-readout-title">Detector debug</div>

      <div className="debug-line">
        dip (smoothed): <strong>{fmt(excursion)}</strong> / need{' '}
        {fmt(downFraction, 2)}
      </div>
      <div className="debug-line">raw dip: {fmt(rawExcursion)}</div>
      <div className="debug-line">up threshold: {fmt(upFraction, 2)}</div>
      <div className="debug-line">
        bodyScale: {fmtPx(bodyScalePx)}{' '}
        {bodyScaleLocked ? '(locked)' : '(live)'}
      </div>
      <div className="debug-line">upperY: {fmtPx(upperBodyY)}</div>
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
