// App.jsx
// -----------------------------------------------------------------------------
// The top-level screen router for UP N AT EM. There are three screens and we
// move between them with a single piece of state:
//
//   'settings'  -> build your workout (SettingsPanel)
//   'workout'   -> the alarm is blaring; do your reps on camera (WorkoutSession)
//   'success'   -> you finished! the alarm is off (success screen)
//
// The alarm hook lives up here so the same instance is shared across screens
// and its start/stop is controlled by the workout flow, never by a mute button.

import { useState } from 'react';
import SettingsPanel from './components/SettingsPanel.jsx';
import WorkoutSession from './components/WorkoutSession.jsx';
import { useAlarm } from './hooks/useAlarm.js';
import './App.css';

export default function App() {
  // Which screen are we on?
  const [screen, setScreen] = useState('settings');
  // The workout the user built in settings (an array of steps).
  const [steps, setSteps] = useState([]);
  // How the last session ended, so the success screen can word things right.
  const [endedEarly, setEndedEarly] = useState(false);

  const alarm = useAlarm();

  // Called from SettingsPanel's Start button (a real user gesture -> audio OK).
  function handleStart(workoutSteps) {
    setSteps(workoutSteps);
    setEndedEarly(false);
    setScreen('workout');
  }

  // Called by WorkoutSession when every step is complete.
  function handleComplete() {
    setEndedEarly(false);
    setScreen('success');
  }

  // Called by the hold-to-cancel emergency escape.
  function handleEmergencyCancel() {
    setEndedEarly(true);
    setScreen('success');
  }

  // Back to the start to set another alarm.
  function handleBackToSettings() {
    setScreen('settings');
  }

  return (
    <main className="app">
      {screen === 'settings' && <SettingsPanel onStart={handleStart} />}

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
            </>
          )}
          <button
            type="button"
            className="start-button"
            onClick={handleBackToSettings}
          >
            Back to settings
          </button>
        </section>
      )}
    </main>
  );
}
