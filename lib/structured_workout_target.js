'use strict';

function extractWorkoutText(ev) {
  const explicit = ev && typeof ev.workout_builder === 'string' ? ev.workout_builder : '';
  if (explicit.trim()) return explicit;

  const description = ev && typeof ev.description === 'string' ? ev.description : '';
  if (!description.trim()) return '';

  const workoutMatch = /^##\s*Workout\b/im.exec(description);
  if (!workoutMatch) return description;

  return description.slice(workoutMatch.index).split(/\r?\n/).slice(1).join('\n');
}

function inferWorkoutTargetFromText(text) {
  if (!text || typeof text !== 'string') return undefined;

  const stepLines = text
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.startsWith('- '));

  let hasPowerTarget = false;
  let hasHrTarget = false;
  let hasPaceTarget = false;

  for (const line of stepLines) {
    const hasHr = /\b(?:HR|LTHR)\b/i.test(line);
    const hasPace = /\bPace\b/i.test(line);

    if (hasHr) hasHrTarget = true;
    if (hasPace) hasPaceTarget = true;

    const withoutHrOrPace = line.replace(/\b(?:HR|LTHR|Pace)\b/gi, '');
    if (!hasHr && !hasPace && (
      /\d+(?:\.\d+)?(?:-\d+(?:\.\d+)?)?%/i.test(withoutHrOrPace) ||
      /\b\d+(?:-\d+)?\s*w\b/i.test(withoutHrOrPace) ||
      /\bZ\d(?:-Z\d)?\b/i.test(withoutHrOrPace) ||
      /\bMMP\b/i.test(withoutHrOrPace) ||
      /\bfreeride\b/i.test(withoutHrOrPace)
    )) {
      hasPowerTarget = true;
    }
  }

  if (hasPaceTarget) return 'PACE';
  if (hasPowerTarget) return 'POWER';
  if (hasHrTarget) return 'HR';
  return undefined;
}

function isWorkoutEvent(ev) {
  return String((ev && ev.category) || 'WORKOUT').toUpperCase() === 'WORKOUT';
}

function applyInferredWorkoutTarget(ev) {
  if (!ev || typeof ev !== 'object' || !isWorkoutEvent(ev)) return ev;

  const target = inferWorkoutTargetFromText(extractWorkoutText(ev));
  if (target) ev.target = target;
  return ev;
}

module.exports = {
  applyInferredWorkoutTarget,
  inferWorkoutTargetFromText,
};
