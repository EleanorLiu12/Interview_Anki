// Run with: node --test tests/srs.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const S = require("../srs.js");

const T0 = Date.UTC(2026, 0, 5, 12);
const TARGET = 0.9;
const fix = (rating, card, now = T0, target = TARGET) => S.grade(card, rating, now, target);
const days = (n) => n * S.DAY;

// A review card with a known stability, last seen at T0.
const reviewCard = (s = 10, e = 2.5) => ({ ph: "r", s, e, last: T0, fz: 1, n: 3, lap: 0 });

test("new card walks the learning steps, then graduates at one day", () => {
  let c = fix(S.GOOD);
  assert.equal(c.ph, "l");
  assert.equal(c.due - T0, 10 * 60e3);
  c = fix(S.GOOD, c);
  assert.equal(c.ph, "r");
  assert.equal(c.s, 1);
  assert.equal(c.n, 2);
});

test("Again keeps a new card in learning at the first step", () => {
  const c = fix(S.AGAIN, fix(S.GOOD));
  assert.equal(c.ph, "l");
  assert.equal(c.st, 0);
  assert.equal(c.due - T0, 60e3);
});

test("Easy on a new card skips ahead to four days", () => {
  const c = fix(S.EASY);
  assert.equal(c.ph, "r");
  assert.equal(c.s, 4);
});

test("preview intervals are strictly ordered for an on-time review", () => {
  const now = T0 + days(10);
  const p = S.preview(reviewCard(), now, TARGET);
  assert.ok(p[S.AGAIN] < p[S.HARD] && p[S.HARD] < p[S.GOOD] && p[S.GOOD] < p[S.EASY]);
});

test("retention follows the forgetting curve and is 90% at one stability", () => {
  const c = reviewCard(10);
  assert.equal(S.retention(c, T0), 1);
  assert.ok(Math.abs(S.retention(c, T0 + days(10)) - 0.9) < 1e-9);
  assert.ok(Math.abs(S.retention(c, T0 + days(20)) - 0.81) < 1e-9);
  assert.equal(S.retention(undefined, T0), null);
});

test("a higher target retention means earlier reviews", () => {
  const c = reviewCard(10);
  assert.ok(S.dueAt(c, 0.95) < S.dueAt(c, 0.9));
  assert.ok(S.dueAt(c, 0.9) < S.dueAt(c, 0.8));
  assert.equal(S.dueAt(c, 0.9), T0 + days(10));
});

test("reviewing immediately earns almost nothing and never hurts", () => {
  const c = fix(S.GOOD, reviewCard(10), T0 + 1000);
  assert.ok(c.s >= 10 && c.s < 10.01);
});

test("reviewing halfway earns partial credit", () => {
  const c = fix(S.GOOD, reviewCard(10), T0 + days(5));
  assert.ok(Math.abs(c.s - 17.5) < 1e-9);
});

test("recalling an overdue card earns more than recalling it on time", () => {
  const onTime = fix(S.GOOD, reviewCard(10), T0 + days(10));
  const late = fix(S.GOOD, reviewCard(10), T0 + days(30));
  assert.ok(Math.abs(onTime.s - 25) < 1e-9);
  assert.ok(Math.abs(late.s - 50) < 1e-9);
});

test("a lapse enters relearning, keeps part of the memory, and returns to review", () => {
  const lapsed = fix(S.AGAIN, reviewCard(10), T0 + days(10));
  assert.equal(lapsed.ph, "x");
  assert.equal(lapsed.s, 3);
  assert.equal(lapsed.lap, 1);
  assert.equal(lapsed.e, 2.3);
  const back = fix(S.GOOD, lapsed, T0 + days(10) + 600e3);
  assert.equal(back.ph, "r");
  assert.equal(back.s, 3);
  assert.equal(back.lap, 1);
});

test("stability has a ceiling and ease stays within bounds", () => {
  const huge = fix(S.EASY, reviewCard(300, 3), T0 + days(300));
  assert.equal(huge.s, 365);
  assert.equal(huge.e, 3);
  let c = reviewCard(10, 1.3);
  c = fix(S.HARD, c, T0 + days(10));
  assert.equal(c.e, 1.3);
});

test("fuzz stays within 5% and is not applied to previews", () => {
  const fz = (r) => S.grade(reviewCard(), S.GOOD, T0 + days(10), TARGET, () => r).fz;
  assert.equal(fz(0), 0.95);
  assert.equal(fz(0.5), 1);
  assert.ok(fz(0.999) < 1.05);
  assert.equal(fix(S.GOOD, reviewCard(), T0 + days(10)).fz, 1);
});

test("Good-only intervals grow like the classic review schedule", () => {
  const ladder = S.goodLadder(TARGET, 5).map(Math.round);
  assert.deepEqual(ladder, [1, 3, 6, 16, 39]);
});

test("the study day rolls over at 4am local time", () => {
  const at = (h) => new Date(2026, 0, 5, h).getTime();
  assert.equal(S.dayNo(at(3)), S.dayNo(at(1)));
  assert.equal(S.dayNo(at(5)), S.dayNo(at(23)));
  assert.equal(S.dayNo(at(5)), S.dayNo(at(3)) + 1);
  assert.equal(S.dayEnd(at(12)), new Date(2026, 0, 6, 4).getTime());
});

test("a one-day card reviewed in the evening is due the next study day, not this one", () => {
  const evening = new Date(2026, 0, 5, 22).getTime();
  const c = { ph: "r", s: 1, e: 2.5, last: evening, fz: 1 };
  assert.equal(S.isDueToday(c, evening, TARGET), false);
  assert.equal(S.isDueToday(c, new Date(2026, 0, 6, 8).getTime(), TARGET), true);
});

test("delays read naturally", () => {
  assert.equal(S.fmtDelay(60e3), "1 分钟");
  assert.equal(S.fmtDelay(90 * 60e3), "2 小时");
  assert.equal(S.fmtDelay(days(3)), "3 天");
  assert.equal(S.fmtDelay(days(45)), "1.5 个月");
  assert.equal(S.fmtDelay(days(365)), "1 年");
});
