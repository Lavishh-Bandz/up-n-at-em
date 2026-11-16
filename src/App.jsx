// App.jsx
// -----------------------------------------------------------------------------
// The top-level screen router for UP N AT EM. There are four screens and we
// move between them with a single piece of state:
//
//   'settings'  -> build your workout + tweak difficulty/progression (SettingsPanel)
//   'workout'   -> the alarm is blaring; do your reps on camera (WorkoutSession)
//   'success'   -> you finished! the alarm is off, with your time (success screen)
//   'tracker'   -> your streak + history over time (ProgressTracker)
//
// The alarm hook lives up here so the same instance is shared across screens
// and its start/stop is controlled by the workout flow, never by a mute button.
//
// CLOCK NOTE: along with useProgress.js, this component is one of only two
// places allowed to read the real clock for progression. In practice App does
// NOT read the clock directly — it delegates to useProgress, which reads it at
// the edge. The pure logic modules stay clock-free.

import { useState } from 'react';
import SettingsPanel from './components/SettingsPanel.jsx';
import WorkoutSession from './components/WorkoutSession.jsx';
import ProgressTracker from './components/ProgressTracker.jsx';
import { useAlarm } from './hooks/useAlarm.js';
import { useProgress } from './hooks/useProgress.js';
import { formatElapsed } from './logic/sessionTimer.js';
import './App.css';

export default function App() {
  // Which screen are we on?
  const [screen, setScreen] = useState('settings');
  // The workout the user built in settings (an array of steps).
  const [steps, setSteps] = useState([]);
  // How the last session ended, so the success screen can word things right.
  const [endedEarly, setEndedEarly] = useState(false);
  // The measured elapsed time (ms) of the last GENUINE completion, so the
  // success screen can show "You finished in 1:23". null until a real finish.
  const [lastElapsedMs, setLastElapsedMs] = useState(null);

  const alarm = useAlarm();
  // The persisted progress/streak/history bridge. This is where the real clock
  // is read at the edge; everything it calls stays pure.
  const progress = useProgress();

  // Called from SettingsPanel's Start button (a real user gesture -> audio OK).
  function handleStart(workoutSteps) {
    setSteps(workoutSteps);
    setEndedEarly(false);
    setScreen('workout');
  }

  // Called by WorkoutSession when every step is complete, with the measured
  // session result { entries:[{exercise, reps}], elapsedMs }.
  //
  // This is the ONLY path that records a completed day: we call
  // progress.completeDay(result), which advances the streak, progresses each
  // target per the difficulty rules, and appends the session (including the
  // timer's elapsedMs) to history. We also stash the elapsed time so the
  // success screen can display it.
  function handleComplete(result) {
    const sessionResult = result || { entries: [], elapsedMs: null };
    setEndedEarly(false);
    setLastElapsedMs(sessionResult.elapsedMs ?? null);
    // Record the finished day into persisted progress (streak + target + history).
    progress.completeDay({
      entries: sessionResult.entries || [],
      elapsedMs: sessionResult.elapsedMs ?? 0,
    });
    setScreen('success');
  }

  // Called by the hold-to-cancel emergency escape. This path records NOTHING:
  // no completion, no skip. An emergency bail-out is never a workout outcome
  // (the deliberate "Skip today" control on the settings screen is the only way
  // to mark a rest day). We do not call progress.completeDay here on purpose.
  function handleEmergencyCancel() {
    setEndedEarly(true);
    setLastElapsedMs(null);
    setScreen('success');
  }

  // Back to the start to set another alarm.
  function handleBackToSettings() {
    setScreen('settings');
  }

  // Open / close the progress tracker.
  function openTracker() {
    setScreen('tracker');
  }

  return (
    <main className="app">
      {screen === 'settings' && (
        <SettingsPanel
          onStart={handleStart}
          progress={progress}
          onOpenTracker={openTracker}
        />
      )}

      {screen === 'workout' && (
        <WorkoutSession
          steps={steps}
          alarm={alarm}
          onComplete={handleComplete}
          onEmergencyCancel={handleEmergencyCancel}
        />
      )}

      {screen === 'success' && (
        <section className="success-screen">
          {endedEarly ? (
            <>
              <h1>Alarm stopped</h1>
              <p className="success-sub">
                You used the emergency exit, so the workout was not completed.
                Stay safe — set another alarm whenever you&apos;re ready.
              </p>
            </>
          ) : (
            <>
              <h1>Alarm dismissed — nice work! 🎉</h1>
              <p className="success-sub">
                You finished every rep. The alarm is off. Go seize the day.
              </p>
              {/* Show the measured session time (v1 just measures + displays +
                  stores it; it does not yet drive progression). */}
              {lastElapsedMs != null && (
                <p className="success-time">
                  You finished in <strong>{formatElapsed(lastElapsedMs)}</strong>
                </p>
              )}
            </>
          )}
          <button
            type="button"
            className="start-button"
            onClick={handleBackToSettings}
          >
            Back to settings
          </button>
          {/* A way into the tracker from the success screen too. */}
          <button type="button" className="tracker-link" onClick={openTracker}>
            View your progress
          </button>
        </section>
      )}

      {screen === 'tracker' && (
        <ProgressTracker
          state={progress.state}
          onBack={handleBackToSettings}
        />
      )}
    </main>
  );
}
