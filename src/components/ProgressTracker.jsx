// ProgressTracker.jsx
// -----------------------------------------------------------------------------
// The PROGRESS & CONSISTENCY tracker — a simple, read-only v1 view of how the
// user is doing over time. It shows:
//
//   - the current STREAK (how many days in a row they have finished),
//   - the current TARGET and chosen DIFFICULTY for each exercise,
//   - a HISTORY list of completed days (date, total reps, how long it took),
//   - a minimal REPS-OVER-TIME visualisation built from the history totals.
//
// It is PRESENTATIONAL ONLY: every number comes straight from the persisted
// progress state (passed in as a prop from App, which owns the useProgress
// hook). This component never reads the clock, never writes storage, and never
// changes any progression rule — it just draws what already happened.
//
// The reps-over-time "chart" is deliberately built from plain <div> bars sized
// with inline CSS widths. We do NOT pull in a charting library for this v1: a
// lightweight bar list is enough to see the trend, keeps the bundle small, and
// is trivial to understand while the user is still learning to code.

import { formatElapsed } from '../logic/sessionTimer.js';
import { EXERCISES } from '../logic/exercises.js';

/**
 * @param {object} props
 * @param {object} props.state   The progress state object from useProgress.
 * @param {() => void} props.onBack  Return to the previous screen.
 */
export default function ProgressTracker({ state, onBack }) {
  // Guard: if somehow opened before state has loaded, show a tiny placeholder.
  if (!state) {
    return (
      <section className="progress-tracker">
        <h1>Your progress</h1>
        <p className="tracker-empty">Loading your progress…</p>
        <button type="button" className="start-button" onClick={onBack}>
          Back
        </button>
      </section>
    );
  }

  // The per-exercise settings map: { pushup: { difficulty, currentTarget, ... } }
  const settingsEntries = Object.entries(state.settings || {});
  // The completed-day log. Newest first reads most naturally in a list, so we
  // copy and reverse (never mutate the stored array).
  const history = Array.isArray(state.history) ? state.history : [];
  const historyNewestFirst = [...history].reverse();

  // For the reps-over-time bars we need the biggest total so every other bar
  // can be drawn as a fraction of it. Guard against an empty history (and avoid
  // dividing by zero) by flooring the max at 1.
  const maxTotalReps = Math.max(1, ...history.map((h) => h.totalReps || 0));

  return (
    <section className="progress-tracker">
      <h1>Your progress</h1>

      {/* ---- Streak ------------------------------------------------------ */}
      <div className="tracker-streak">
        <span className="tracker-streak-number">{state.streak || 0}</span>
        <span className="tracker-streak-label">
          day{state.streak === 1 ? '' : 's'} in a row
        </span>
      </div>

      {/* ---- Current targets + difficulty -------------------------------- */}
      <h2>Current targets</h2>
      <ul className="tracker-targets">
        {settingsEntries.map(([exerciseId, s]) => {
          const label = EXERCISES[exerciseId]
            ? EXERCISES[exerciseId].label
            : exerciseId;
          return (
            <li key={exerciseId} className="tracker-target-row">
              <strong>{label}</strong>: {s.currentTarget} reps
              <span className="tracker-target-meta">
                {' '}
                ({s.difficulty}, starts at {s.startingTarget}
                {s.autoIncrease ? ', auto-increasing' : ', holding'})
              </span>
            </li>
          );
        })}
      </ul>

      {/* ---- Reps over time (lightweight inline bars) -------------------- */}
      <h2>Reps over time</h2>
      {history.length === 0 ? (
        <p className="tracker-empty">
          No completed workouts yet. Finish a workout and it will show up here.
        </p>
      ) : (
        <ul className="tracker-bars">
          {history.map((entry, i) => {
            // Width as a percentage of the biggest day, so the tallest bar is
            // always full width and the rest scale relative to it.
            const widthPct = Math.round(
              ((entry.totalReps || 0) / maxTotalReps) * 100
            );
            return (
              <li key={`${entry.date}-${i}`} className="tracker-bar-row">
                <span className="tracker-bar-date">{entry.date}</span>
                <span className="tracker-bar-track">
                  <span
                    className="tracker-bar-fill"
                    style={{ width: `${widthPct}%` }}
                  />
                </span>
                <span className="tracker-bar-value">{entry.totalReps}</span>
              </li>
            );
          })}
        </ul>
      )}

      {/* ---- Completed-day history list ---------------------------------- */}
      <h2>Completed days</h2>
      {historyNewestFirst.length === 0 ? (
        <p className="tracker-empty">Your finished workouts will be listed here.</p>
      ) : (
        <ul className="tracker-history">
          {historyNewestFirst.map((entry, i) => (
            <li key={`${entry.date}-${i}`} className="tracker-history-row">
              <span className="tracker-history-date">{entry.date}</span>
              <span className="tracker-history-reps">
                {entry.totalReps} reps
              </span>
              <span className="tracker-history-time">
                in {formatElapsed(entry.elapsedMs)}
              </span>
            </li>
          ))}
        </ul>
      )}

      <button type="button" className="start-button" onClick={onBack}>
        Back
      </button>
    </section>
  );
}
