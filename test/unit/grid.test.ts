import { test } from "node:test";
import assert from "node:assert/strict";
import type { World } from "../../world/contracts.js";
import {
	DIAGONALS, NEIGHBOURS, bounds, coincident, desiredEdges, edgeId, edgeSpec, newTile, tileConfig, tileKey,
} from "../../world/grid.js";

/** A world of tile size T holding [x, y, instanceId?] tiles. */
function world(tileSize: number, tiles: [number, number, number?][]): World {
	const w: World = {
		id: "0000abcd.1", trace: "0000abcd.2", createdAtMs: 0, tileSize, surface: "nauvis", seed: 7, ticksPerDay: 25000,
		epochMs: 0, epochDaytime: 0, deleting: false, tiles: {},
	};
	for (const [x, y, instanceId] of tiles) {
		w.tiles[tileKey(x, y)] = { ...newTile(x, y, `t${x},${y}`, 0), instanceId };
	}
	return w;
}

test("tile (x, y) covers [xT − T/2, xT + T/2) × [yT − T/2, yT + T/2), at negative coordinates too", () => {
	assert.deepEqual(bounds(512, 0, 0), [-256, -256, 256, 256]);
	assert.deepEqual(bounds(512, -1, 2), [-768, 768, -256, 1280]);
	assert.deepEqual(bounds(64, 3, -5), [160, -352, 224, -288]);
	for (const T of [64, 512, 4096]) {
		assert.ok(bounds(T, 5, -3).every(v => v % 32 === 0), `T = ${T} is chunk-aligned`);
	}
});

test("the neighbours are the 4 orthogonal tiles; each corner square lies in its diagonal tile", () => {
	assert.deepEqual(NEIGHBOURS, [[0, -1], [1, 0], [0, 1], [-1, 0]]);
	assert.deepEqual(DIAGONALS, { ne: [1, -1], se: [1, 1], sw: [-1, 1], nw: [-1, -1] });
});

test("SP1 spec §8's worked example: tiles (0,−1) and (0,0) at T = 512", () => {
	const w = world(512, [[0, -1, 11], [0, 0, 12]]);
	const spec = edgeSpec(w, "nauvis", w.tiles["0,-1"], w.tiles["0,0"]);
	assert.deepEqual(spec.a, { instanceId: 11, surface: "nauvis", origin: [256, -256], facing: 8 });
	assert.deepEqual(spec.b, { instanceId: 12, surface: "nauvis", origin: [-256, -256], facing: 0 });
	assert.deepEqual([spec.id, spec.owner, spec.length], ["gridworld:0000abcd.1:0,-1:0,0:11,12", "gridworld", 512]);
});

test("a horizontal pair at negative x: a faces east, b faces west, both on the shared border", () => {
	const w = world(64, [[-1, 2, 5], [0, 2, 6]]);
	const spec = edgeSpec(w, "nauvis", w.tiles["-1,2"], w.tiles["0,2"]);
	assert.deepEqual([spec.a.origin, spec.a.facing, spec.b.origin, spec.b.facing], [[-32, 96], 4, [-32, 160], 12]);
});

test("every edge of a 7 × 7 grid is coincident, and side a is always the north or west tile", () => {
	const tiles: [number, number, number][] = [];
	let id = 1;
	for (let x = -3; x <= 3; x++) {
		for (let y = -3; y <= 3; y++) {
			tiles.push([x, y, id]);
			id += 1;
		}
	}
	const specs = desiredEdges(world(128, tiles), () => true);
	assert.equal(specs.length, 2 * 7 * 6);
	for (const s of specs) {
		assert.ok(coincident(s.a, s.b, s.length), s.id);
		const [, , ta, tb] = s.id.split(":");
		const [ax, ay] = ta.split(",").map(Number);
		const [bx, by] = tb.split(",").map(Number);
		assert.ok((bx === ax + 1 && by === ay) || (bx === ax && by === ay + 1), `${s.id}: a is north or west of b`);
	}
});

test("an edge needs both instances in Clusterio; its id names both, so a new instance makes a new edge", () => {
	const w = world(64, [[0, 0, 7], [1, 0, 8], [0, 1]]);
	assert.deepEqual(desiredEdges(w, () => true).map(s => s.id), ["gridworld:0000abcd.1:0,0:1,0:7,8"]);
	assert.deepEqual(desiredEdges(w, id => id !== 8), [], "an instance Clusterio lacks has no edge");
	w.tiles["1,0"].instanceId = 9;
	assert.equal(edgeId(w, "nauvis", w.tiles["0,0"], w.tiles["1,0"]), "gridworld:0000abcd.1:0,0:1,0:7,9");
	assert.ok(edgeId(w, "nauvis", w.tiles["0,0"], w.tiles["1,0"]).length <= 128, "within SP1's 128 characters");
	assert.throws(() => edgeSpec(w, "nauvis", w.tiles["0,0"], w.tiles["0,1"]), /need instances/);
	assert.throws(() => edgeSpec(w, "nauvis", w.tiles["1,0"], w.tiles["0,0"]), /not a north or west/);
});

test("coincident rejects sides that don't stitch", () => {
	assert.equal(coincident({ origin: [0, 0], facing: 8 }, { origin: [-64, 0], facing: 0 }, 64), true);
	assert.equal(coincident({ origin: [0, 0], facing: 8 }, { origin: [64, 0], facing: 0 }, 64), false);
	assert.equal(coincident({ origin: [0, 0], facing: 8 }, { origin: [-64, 0], facing: 8 }, 64), false);
});

test("a tile's config is its identity plus its trace", () => {
	const w = world(512, [[2, -3, 9]]);
	assert.deepEqual(tileConfig(w, w.tiles["2,-3"]), {
		world: "0000abcd.1", x: 2, y: -3, size: 512, surface: "nauvis", seed: 7, trace: "t2,-3",
	});
});

const FIVE = ["aquilo", "fulgora", "gleba", "nauvis", "vulcanus"];

test("surfaces §6: a planet's edge id has its surface after the world id; the base planet keeps SP2's id", () => {
	const w = world(64, [[0, 0, 7], [1, 0, 8]]);
	const [a, b] = [w.tiles["0,0"], w.tiles["1,0"]];
	assert.equal(edgeId(w, "nauvis", a, b), "gridworld:0000abcd.1:0,0:1,0:7,8");
	assert.equal(edgeId(w, "vulcanus", a, b), "gridworld:0000abcd.1:vulcanus:0,0:1,0:7,8");
	assert.equal(
		edgeId(w, "some-mod-planet", a, b), "gridworld:0000abcd.1:some-mod-planet:0,0:1,0:7,8", "a modded name",
	);
	const nauvis = edgeSpec(w, "nauvis", a, b);
	const vulcanus = edgeSpec(w, "vulcanus", a, b);
	assert.deepEqual([vulcanus.a.surface, vulcanus.b.surface], ["vulcanus", "vulcanus"]);
	assert.deepEqual([vulcanus.a.origin, vulcanus.b.origin], [nauvis.a.origin, nauvis.b.origin], "the same geometry");
});

test("surfaces §6: a pair gets the base planet's edge with no reports, and one per planet both report", () => {
	const w = world(64, [[0, 0, 7], [1, 0, 8], [0, 1, 9]]);
	const ids = (exists: (id: number) => boolean = () => true) => desiredEdges(w, exists).map(s => s.id).sort();
	assert.deepEqual(
		ids(), ["gridworld:0000abcd.1:0,0:0,1:7,9", "gridworld:0000abcd.1:0,0:1,0:7,8"], "no report: Nauvis",
	);
	w.tiles["0,0"].planets = ["fulgora", "nauvis", "vulcanus"];
	w.tiles["1,0"].planets = ["gleba", "nauvis", "vulcanus"];
	assert.deepEqual(ids(), [
		"gridworld:0000abcd.1:0,0:0,1:7,9",
		"gridworld:0000abcd.1:0,0:1,0:7,8",
		"gridworld:0000abcd.1:vulcanus:0,0:1,0:7,8",
	], "Vulcanus, which both report; not Fulgora or Gleba, which one does; Nauvis once");
	assert.deepEqual(
		ids(id => id !== 8), ["gridworld:0000abcd.1:0,0:0,1:7,9"], "a spec only when both instances exist",
	);
});

test("surfaces §6: no two planets share an id over a 7 × 7 grid; each spec's sides name its planet and stitch", () => {
	const tiles: [number, number, number][] = [];
	let id = 1;
	for (let x = -3; x <= 3; x++) {
		for (let y = -3; y <= 3; y++) {
			tiles.push([x, y, id]);
			id += 1;
		}
	}
	const w = world(128, tiles);
	for (const t of Object.values(w.tiles)) {
		t.planets = FIVE;
	}
	const specs = desiredEdges(w, () => true);
	assert.equal(specs.length, 5 * 2 * 7 * 6);
	assert.equal(new Set(specs.map(s => s.id)).size, specs.length, "every id distinct");
	for (const s of specs) {
		const parts = s.id.split(":");
		const planet = parts.length === 6 ? parts[2] : "nauvis";
		assert.ok(parts.length === 5 || planet !== "nauvis", `${s.id}: Nauvis has no planet segment`);
		assert.deepEqual([s.a.surface, s.b.surface], [planet, planet], s.id);
		assert.ok(coincident(s.a, s.b, s.length), s.id);
	}
});

test("surfaces §4.3: a tile's config carries the world's exclude list only when it has one", () => {
	const w = world(512, [[2, -3, 9]]);
	assert.ok(!("exclude" in tileConfig(w, w.tiles["2,-3"])), "a world without one: SP2's config exactly");
	w.exclude = ["gleba"];
	assert.deepEqual(tileConfig(w, w.tiles["2,-3"]).exclude, ["gleba"]);
});
