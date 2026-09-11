// Derive the clock from the saved start time so refreshes and background tabs
// never reset or extend an interview.
export function getInterviewClock(startedAt: number, durationMinutes: number, now = Date.now()) {
  const durationSeconds = durationMinutes * 60;
  const remainingSeconds = Math.max(0, Math.ceil((startedAt + durationSeconds * 1000 - now) / 1000));
  const closingSeconds = Math.min(30, Math.max(10, Math.floor(durationSeconds * 0.2)));
  return {
    remainingSeconds,
    isClosing: remainingSeconds <= closingSeconds,
    isExpired: remainingSeconds === 0,
  };
}
