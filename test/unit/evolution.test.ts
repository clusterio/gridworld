import { test } from "node:test";
import assert from "node:assert/strict";
import { addReport, advance, newEvolution, parts } from "../../world/evolution.js";

test("a report adds each planet's growth; a planet first seen takes the reported time part", () => {
	const s = newEvolution();
	addReport(s, [{ surface: "nauvis", time: 0.5, pollution: 0.25, kills: 0.0625 }], 0.000004);
	addReport(s, [
		{ surface: "nauvis", time: 0.75, pollution: 0.125, kills: 0 },
		{ surface: "gleba", time: 0.25, pollution: 0, kills: 0 },
	], 0.000005);
	assert.deepEqual(s.planets.nauvis, { time: 0.5, pollution: 0.375, kills: 0.0625 });
	assert.deepEqual(s.planets.gleba, { time: 0.25, pollution: 0, kills: 0 });
	assert.equal(s.timeFactor, 0.000005);
});

test("the time part advances by time_factor a second, undamped (spike 34 E2)", () => {
	const s = newEvolution();
	addReport(s, [{ surface: "nauvis", time: 0.25, pollution: 0.25, kills: 0 }], 0.000004);
	advance(s, 60);
	assert.ok(Math.abs(s.planets.nauvis.time - (0.25 + 0.000004 * 60)) < 1e-15);
	const full = newEvolution();
	addReport(full, [{ surface: "nauvis", time: 0.5, pollution: 0.5, kills: 0 }], 0.000004);
	advance(full, 60);
	assert.ok(Math.abs(full.planets.nauvis.time - (0.5 + 0.000004 * 60)) < 1e-15, "no full planet stands still");
});

test("parts lists every planet for the apply", () => {
	const s = newEvolution();
	addReport(s, [{ surface: "nauvis", time: 0.5, pollution: 0.125, kills: 0.0625 }], 0.000004);
	assert.deepEqual(parts(s), [{ surface: "nauvis", time: 0.5, pollution: 0.125, kills: 0.0625 }]);
});
