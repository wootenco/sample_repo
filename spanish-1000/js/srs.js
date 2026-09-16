/* Spaced repetition scheduler: SM-2 with learning steps and lapse handling.
 *
 * Why SM-2 and not a fixed Leitner box: the interval has to adapt to how
 * hard a given word is FOR YOU. "que" and "desafío" are both on the list;
 * they do not deserve the same review schedule. The ease factor is the
 * per-card knob that makes that happen.
 *
 * The scheduling principle underneath: retrieval strengthens memory in
 * proportion to how close you were to forgetting. Reviewing too early is
 * cheap but nearly worthless; reviewing too late means relearning from
 * scratch. Expanding intervals aim at roughly 90% recall at review time.
 */

const MIN_EF = 1.3;
const DEFAULT_EF = 2.5;
const LEARNING_STEPS = [1, 10];        // minutes
const RELEARN_STEPS = [10];            // minutes, after a lapse
const GRADED_EASY_BONUS = 1.3;
const INTERVAL_FUZZ = 0.05;            // +/- 5% so cards don't clump
const MAX_INTERVAL = 365;              // days

const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;

/* Grades: 0 again, 1 hard, 2 good, 3 easy. Mapped to SM-2's 0-5 internally. */
const GRADE = { AGAIN: 0, HARD: 1, GOOD: 2, EASY: 3 };
const SM2_Q = { 0: 1, 1: 3, 2: 4, 3: 5 };

function newCard(item, type, now) {
  return {
    item, type,
    state: "new",
    step: 0,
    ef: DEFAULT_EF,
    ivl: 0,            // days, for review-state cards
    reps: 0,
    lapses: 0,
    due: now,
    last: 0,
  };
}

function fuzz(days) {
  if (days < 2) return days;
  const spread = days * INTERVAL_FUZZ;
  return days + (Math.random() * 2 - 1) * spread;
}

function updateEase(ef, grade) {
  const q = SM2_Q[grade];
  const next = ef + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02));
  return Math.max(MIN_EF, Math.round(next * 1000) / 1000);
}

/* Returns a NEW card object; never mutates the one passed in. */
function schedule(card, grade, now) {
  const c = { ...card, reps: card.reps + 1, last: now };

  if (c.state === "new" || c.state === "learning") {
    if (grade === GRADE.AGAIN) {
      c.step = 0;
      c.state = "learning";
      c.due = now + LEARNING_STEPS[0] * MIN;
      return c;
    }
    if (grade === GRADE.EASY) {            // skip the rest of the steps
      c.state = "review";
      c.ivl = 4;
      c.due = now + Math.round(fuzz(c.ivl) * DAY);
      c.ef = updateEase(c.ef, grade);
      return c;
    }
    const nextStep = grade === GRADE.HARD ? c.step : c.step + 1;
    if (nextStep >= LEARNING_STEPS.length) {
      c.state = "review";
      c.ivl = 1;
      c.due = now + Math.round(fuzz(c.ivl) * DAY);
    } else {
      c.state = "learning";
      c.step = nextStep;
      c.due = now + LEARNING_STEPS[nextStep] * MIN;
    }
    return c;
  }

  if (c.state === "relearn") {
    if (grade === GRADE.AGAIN) {
      c.due = now + RELEARN_STEPS[0] * MIN;
      return c;
    }
    c.state = "review";
    c.ivl = Math.max(1, Math.round(c.ivl * 0.5));   // resume, reduced
    c.due = now + Math.round(fuzz(c.ivl) * DAY);
    return c;
  }

  // state === "review"
  if (grade === GRADE.AGAIN) {
    c.lapses += 1;
    c.ef = updateEase(c.ef, grade);
    c.state = "relearn";
    c.step = 0;
    c.ivl = Math.max(1, Math.round(c.ivl * 0.4));
    c.due = now + RELEARN_STEPS[0] * MIN;
    return c;
  }

  c.ef = updateEase(c.ef, grade);
  let ivl;
  if (grade === GRADE.HARD) ivl = Math.max(c.ivl + 1, c.ivl * 1.2);
  else if (grade === GRADE.GOOD) ivl = c.ivl * c.ef;
  else ivl = c.ivl * c.ef * GRADED_EASY_BONUS;

  c.ivl = Math.min(MAX_INTERVAL, Math.max(1, Math.round(ivl)));
  c.due = now + Math.round(fuzz(c.ivl) * DAY);
  return c;
}

/* A card counts as "known" once it has survived to a real review interval.
 * One correct answer on the day you met the word is not knowledge. */
function isLearned(card) {
  return card && card.state === "review" && card.ivl >= 1;
}

/* Comfortably in long-term memory: the threshold used for coverage stats. */
function isMature(card) {
  return card && card.state === "review" && card.ivl >= 21;
}

function dueCount(cards, now) {
  return Object.values(cards).filter(c => c.due <= now).length;
}
