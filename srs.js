// Spaced-repetition scheduler: an Ebbinghaus-style exponential forgetting curve with SM-2-style ease.
//
// Each reviewed card has a stability s (days): the time for its recall probability to fall to 90%.
//   R(t) = 0.9 ^ (t / s)
// A card comes due when R falls to the target retention, so the target directly sets how often you review.
// Reviews are forgiving by design: early ones earn proportional credit, late ones earn a bonus if recalled.
(function (root) {
  const MIN = 6e4, HOUR = 36e5, DAY = 864e5;
  const LEARN_STEPS = [1, 10], RELEARN_STEPS = [10]; // minutes
  const ROLLOVER = 4 * HOUR;                         // a study day ends at 4am, so late-night reviews count as today
  const EASE_START = 2.5, EASE_MIN = 1.3, EASE_MAX = 3;
  const MAX_STABILITY = 365;
  const AGAIN = 1, HARD = 2, GOOD = 3, EASY = 4;

  const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
  const isNew = (c) => !c || !c.ph;
  const isLearning = (c) => !!c && (c.ph === "l" || c.ph === "x");
  const isReview = (c) => !!c && c.ph === "r";

  // Days until recall probability falls to target. Never under a day once a card has graduated.
  const interval = (s, target) => Math.max(1, s * Math.log(target) / Math.log(0.9));

  function dueAt(c, target) {
    return isReview(c) ? c.last + interval(c.s, target) * (c.fz || 1) * DAY : c.due;
  }

  // Estimated recall probability now; null if the card has no memory yet.
  function retention(c, now) {
    if (!c || !c.s || !c.last) return null;
    return Math.pow(0.9, Math.max(0, now - c.last) / DAY / c.s);
  }

  const dayNo = (ms) => Math.floor((ms - new Date(ms).getTimezoneOffset() * MIN - ROLLOVER) / DAY);
  // First millisecond of the next study day.
  const dayEnd = (ms) => (dayNo(ms) + 1) * DAY + ROLLOVER + new Date(ms).getTimezoneOffset() * MIN;

  const isDueToday = (c, now, target) => isReview(c) && dueAt(c, target) < dayEnd(now);

  // Spread due dates a little so cards learned together don't stay clumped forever.
  const fuzz = (rng) => (rng ? 0.95 + rng() * 0.1 : 1);

  function graduate(c, s, now, rng) {
    return Object.assign({}, c, { ph: "r", s: clamp(s, 1, MAX_STABILITY), last: now, fz: fuzz(rng), st: undefined, due: undefined });
  }

  function gradeLearning(c, rating, now, rng) {
    const steps = c.ph === "x" ? RELEARN_STEPS : LEARN_STEPS;
    const st = Math.min(c.st || 0, steps.length - 1);
    const stay = (step, minutes) => Object.assign({}, c, { st: step, due: now + minutes * MIN });
    if (rating === AGAIN) return stay(0, steps[0]);
    if (rating === HARD) return stay(st, st + 1 < steps.length ? (steps[st] + steps[st + 1]) / 2 : steps[st] * 1.5);
    if (rating === GOOD && st + 1 < steps.length) return stay(st + 1, steps[st + 1]);
    if (c.ph === "x") return graduate(c, rating === EASY ? c.s * 1.5 : c.s, now, rng);
    return graduate(c, rating === EASY ? 4 : 1, now, rng);
  }

  function gradeReview(c, rating, now, target, rng) {
    const e = c.e;
    if (rating === AGAIN) {
      return Object.assign({}, c, { ph: "x", st: 0, due: now + RELEARN_STEPS[0] * MIN, s: Math.max(1, c.s * 0.3),
        e: clamp(e - 0.2, EASE_MIN, EASE_MAX), lap: (c.lap || 0) + 1 });
    }
    const t = (now - c.last) / DAY, due = interval(c.s, target) * (c.fz || 1);
    const growth = { [HARD]: 1.2, [GOOD]: e, [EASY]: e * 1.3 }[rating];
    const lateBonus = { [HARD]: 0.25, [GOOD]: 0.5, [EASY]: 1 }[rating];
    const s = t < due
      ? c.s * (1 + (growth - 1) * (t / due))     // early: credit in proportion to how much time really passed
      : (c.s + lateBonus * (t - due)) * growth;  // late: still recalled, so the memory was stronger than estimated
    const nextEase = { [HARD]: e - 0.15, [GOOD]: e + (EASE_START - e) * 0.02, [EASY]: e + 0.15 }[rating];
    return graduate(Object.assign({}, c, { e: clamp(nextEase, EASE_MIN, EASE_MAX) }), s, now, rng);
  }

  // Pure: returns the card's next state. Pass rng only when committing; previews omit it to stay stable.
  function grade(card, rating, now, target, rng) {
    const c = isNew(card) ? { ph: "l", st: 0, e: EASE_START, n: 0, lap: 0 } : card;
    const next = isLearning(c) ? gradeLearning(c, rating, now, rng) : gradeReview(c, rating, now, target, rng);
    next.n = (c.n || 0) + 1;
    return next;
  }

  // Milliseconds until the card returns, for each rating (labels on the grade buttons).
  function preview(card, now, target) {
    const out = {};
    for (const r of [AGAIN, HARD, GOOD, EASY]) out[r] = dueAt(grade(card, r, now, target), target) - now;
    return out;
  }

  function fmtDelay(ms) {
    if (ms < HOUR) return Math.max(1, Math.round(ms / MIN)) + " 分钟";
    if (ms < DAY) return Math.round(ms / HOUR) + " 小时";
    const d = ms / DAY;
    if (d < 30) return Math.round(d) + " 天";
    if (d < 365) return (d / 30).toFixed(1).replace(/\.0$/, "") + " 个月";
    return (d / 365).toFixed(1).replace(/\.0$/, "") + " 年";
  }

  // Intervals (days) if a brand-new card were graded Good every time it comes due.
  function goodLadder(target, count) {
    let c, now = 0;
    const out = [];
    while (out.length < count) {
      c = grade(c, GOOD, now, target);
      if (isReview(c)) {
        const days = (dueAt(c, target) - now) / DAY;
        out.push(days);
        if (c.s >= MAX_STABILITY) break;
      }
      now = dueAt(c, target);
    }
    return out;
  }

  const api = { AGAIN, HARD, GOOD, EASY, DAY, isNew, isLearning, isReview, interval, dueAt, retention, dayNo, dayEnd,
    isDueToday, grade, preview, fmtDelay, goodLadder };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.SRS = api;
})(typeof window !== "undefined" ? window : globalThis);
