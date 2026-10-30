import { test } from "node:test";
import assert from "node:assert/strict";
import type { EdgeRecord, EdgeSpec } from "universal_edges/edges";
import type { World } from "../../world/contracts.js";
import { desiredEdges, newTile, tileKey } from "../../world/grid.js";
import { planEdges } from "../../world/plan.js";
import { settle, setup } from "./fakes.js";

function world(id: string, tiles: [number, number, number][]): World {
	const w: World = {
		id, trace: `${id}.t`, createdAtMs: 0, tileSize: 64, surface: "nauvis", seed: 7, ticksPerDay: 25000, epochMs: 0,
		epochDaytime: 0, deleting: false, tiles: {},
	};
	for (const [x, y, instanceId] of tiles) {
		w.tiles[tileKey(x, y)] = { ...newTile(x, y, "t", 0), instanceId };
	}
	return w;
}

const record = (s: EdgeSpec, fields: Partial<EdgeRecord> = {}): EdgeRecord => ({
	...s, revision: 1, deleted: false, connectors: [], trace: "t", updatedAtMs: 0, ...fields,
});
const square = () => desiredEdges(world("w1", [[0, 0, 1], [1, 0, 2], [0, 1, 3], [1, 1, 4]]), () => true);

test("the desired set: one edge per orthogonal pair whose instances both exist", () => {
	assert.deepEqual(square().map(s => s.id).sort(), [
		"gridworld:w1:0,0:0,1:1,3", "gridworld:w1:0,0:1,0:1,2", "gridworld:w1:0,1:1,1:3,4", "gridworld:w1:1,0:1,1:2,4",
	]);
});

test("a missing edge is ensured, an equal one is left alone, and a tombstone waits for its purge", () => {
	const [e1, e2, e3] = square();
	const plan = planEdges([e1, e2, e3], [record(e1), record(e2, { deleted: true })]);
	assert.deepEqual([plan.ensure.map(s => s.id), plan.remove, plan.rejected], [[e3.id], [], []]);
});

test("a live edge with the id but another spec is rejected, never re-ensured", () => {
	const [e1] = square();
	const plan = planEdges([e1], [record({ ...e1, length: 65 })]);
	assert.deepEqual([plan.ensure, plan.remove, plan.rejected], [[], [], [e1.id]]);
});

test("a replaced tile's new instance gives a new id: the old edge goes, the new one comes, in one pass", () => {
	const before = desiredEdges(world("w1", [[0, 0, 1], [1, 0, 2]]), () => true);
	const after = desiredEdges(world("w1", [[0, 0, 1], [1, 0, 7]]), () => true);
	const plan = planEdges(after, before.map(s => record(s)));
	assert.deepEqual(plan.ensure.map(s => s.id), ["gridworld:w1:0,0:1,0:1,7"]);
	assert.deepEqual(plan.remove, ["gridworld:w1:0,0:1,0:1,2"]);
});

test("another world's live edges are removed; other owners' edges are never touched", () => {
	const [old] = desiredEdges(world("w0", [[0, 0, 1], [1, 0, 2]]), () => true);
	const manual = record({ ...old, id: "manual-1", owner: "manual" });
	const plan = planEdges([], [record(old), manual, record({ ...old, id: "gridworld:w0:gone" }, { deleted: true })]);
	assert.deepEqual([plan.ensure, plan.remove, plan.rejected], [[], [old.id], []]);
});

test("the reconciler ensures desired edges; a tombstone waits; UE's purged event brings the next ensure", async () => {
	const { store, reconciler, edges, lines } = setup();
	await reconciler.createWorld({ tileSize: 64 });
	await reconciler.createTile(1, 0);
	await settle();
	const id = `gridworld:${store.world!.id}:0,0:1,0:101,102`;
	assert.equal(edges.records.get(id)?.deleted, false);
	assert.ok(lines.some(l => l.meta.op === "gw.edge" && l.meta.phase === "ensured" && l.meta.ueTrace === `ue.${id}`));
	edges.records.get(id)!.deleted = true;
	reconciler.trigger();
	await settle();
	assert.equal(edges.records.get(id)?.deleted, true, "a tombstone is left to purge");
	edges.records.delete(id);
	edges.emit({ kind: "purged", id });
	await settle();
	assert.equal(edges.records.get(id)?.deleted, false, "ensured again after the purge");
});

test("an EdgeDeleting rejection is quiet; other rejections are logged", async () => {
	const { reconciler, edges, lines } = setup();
	let code = "EdgeDeleting";
	edges.api.ensure = async () => {
		throw Object.assign(new Error(`refused: ${code}`), { code });
	};
	await reconciler.createWorld({ tileSize: 64 });
	await reconciler.createTile(1, 0);
	await settle();
	assert.ok(!lines.some(l => l.meta.phase === "rejected"));
	code = "EdgeConflict";
	reconciler.trigger();
	await settle();
	assert.ok(lines.some(l => l.meta.phase === "rejected" && /EdgeConflict/.test(String(l.meta.error))));
});

test("a replaced tile keeps its planets (W26, Review Focus 1): every planet's edge moves to the new id", () => {
	const five = (w: World) => {
		for (const t of Object.values(w.tiles)) {
			t.planets = ["aquilo", "fulgora", "gleba", "nauvis", "vulcanus"];
		}
		return w;
	};
	const before = desiredEdges(five(world("w1", [[0, 0, 1], [1, 0, 2]])), () => true);
	const after = desiredEdges(five(world("w1", [[0, 0, 1], [1, 0, 7]])), () => true);
	const plan = planEdges(after, before.map(s => record(s)));
	assert.equal(plan.ensure.length, 5, "Nauvis's and four planets'");
	assert.ok(plan.ensure.every(s => s.id.endsWith(":1,7")), "every new id names the new instance");
	assert.deepEqual([...plan.remove].sort(), before.map(s => s.id).sort(), "every old id goes, in the same pass");
	assert.equal(plan.rejected.length, 0);
});
