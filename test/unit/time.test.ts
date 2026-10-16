import { test } from "node:test";
import assert from "node:assert/strict";
import { OffsetClock, canonical, period, synced } from "../../world/time.js";

test("canonical(t) = (epochDaytime + (t − epochMs) / msPerDay) mod 1, in [0, 1)", () => {
	const anchor = { epochMs: 1_000_000, epochDaytime: 0.25, ticksPerDay: 25000 };
	const day = 25000 / 60 * 1000;
	assert.equal(canonical(anchor, 1_000_000), 0.25);
	assert.ok(Math.abs(canonical(anchor, 1_000_000 + day / 2) - 0.75) < 1e-12, "half a day on");
	assert.ok(Math.abs(canonical(anchor, 1_000_000 + day) - 0.25) < 1e-12, "a whole day on");
	assert.ok(Math.abs(canonical(anchor, 1_000_000 - day / 2) - 0.75) < 1e-12, "before the epoch wraps into [0, 1)");
	for (const t of [0, 1e12, -5e11, 1_000_000 - day / 4]) {
		const d = canonical(anchor, t);
		assert.ok(d >= 0 && d < 1, `${t}: ${d}`);
	}
});

test("the offset clock keeps the largest sentAtMs − now sample: the least delayed anchor", () => {
	const clock = new OffsetClock();
	assert.equal(clock.now(500), 500, "no sample yet: the host's own clock");
	clock.sample(1000, 900);
	assert.equal(clock.now(0), 100);
	clock.sample(2000, 1950);
	assert.equal(clock.now(0), 100, "a more delayed anchor is ignored");
	clock.sample(3000, 2850);
	assert.equal(clock.now(0), 150);
});

test("surfaces §9.1: a planet's period is a quarter of its day, at most 60 s; 1200 ticks gives 5 s", () => {
	assert.deepEqual([25000, 14400, 10800, 5400, 1200].map(day => period(day)), [3600, 3600, 2700, 1350, 300]);
});

test("surfaces §9.4: synced lists the planets reported with a day, the base planet at the anchor's day", () => {
	const anchor = { epochMs: 0, epochDaytime: 0, ticksPerDay: 30000 };
	const reported = [
		{ surface: "nauvis", ticksPerDay: 25200 }, { surface: "vulcanus", ticksPerDay: 5400 }, { surface: "aquilo" },
	];
	assert.deepEqual(synced("nauvis", anchor, reported), [
		{ surface: "nauvis", ticksPerDay: 30000 }, { surface: "vulcanus", ticksPerDay: 5400 },
	], "the base planet at the world's day; a planet with no day sends nothing");
	assert.equal(synced("nauvis", anchor, []).length, 0, "before the first report: nothing");
});

test("surfaces §9.3: one epoch, each planet's own day — half a Vulcanus day is 45 s", () => {
	const anchor = { epochMs: 1_000_000, epochDaytime: 0.25, ticksPerDay: 5400 };
	assert.ok(Math.abs(canonical(anchor, 1_000_000 + 45_000) - 0.75) < 1e-12);
});
