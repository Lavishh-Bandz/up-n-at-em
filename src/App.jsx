// Placeholder app shell for UP N AT EM.
//
// This first feature only establishes the project and the PURE, testable
// logic (angle math, rep counter, exercises, workout queue). The real UI
// (live camera, pose-detection skeleton overlay, settings, and the alarm
// that will not stop until you finish your reps) arrives in later features.
export default function App() {
  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: '2rem' }}>
      <h1>UP N AT EM</h1>
      <p>
        Wake up and work out. The alarm will not stop until you complete your
        push-ups and/or sit-ups on camera.
      </p>
      <p style={{ color: '#666' }}>
        Proof-of-concept scaffold. Camera, pose detection, and alarm UI are
        coming in the next steps.
      </p>
    </main>
  );
}
