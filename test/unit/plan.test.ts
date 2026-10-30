import { test } from "node:test";
import assert from "node:assert/strict";
import type { Tile, World } from "../../world/contracts.js";
import { newTile, tileKey } from "../../world/grid.js";
import {
	connectedHosts, deletedByName, growth, planTiles, type Action, type Facts, type InstanceFact, type Trigger,
} from "../../world/plan.js";

const NOW = 1_000_000;

/** A world with the given tiles; each tile's trace is "trace x,y". */
function world(tiles: Partial<Tile>[], extra: Partial<World> = {}): World {
	const w: World = {
		id: "0000abcd.1", trace: "0000abcd.2", createdAtMs: 0, tileSize: 64, surface: "nauvis", seed: 7,
		ticksPerDay: 25000, epochMs: 0, epochDaytime: 0, deleting: false, tiles: {}, ...extra,
	};
	for (const t of tiles) {
		const x = t.x ?? 0;
		const y = t.y ?? 0;
		w.tiles[tileKey(x, y)] = { ...newTile(x, y, `trace ${x},${y}`, 0), ...t };
	}
	return w;
}

const inst = (id: number, status: string, host: number | null, hasSave = false, name = "x"): InstanceFact => ({
	id, name, status, host, hasSave,
});

function facts(instances: InstanceFact[], extra: Partial<Facts> = {}): Facts {
	return {
		nowMs: NOW, instances: new Map(instances.map(i => [i.id, i])), hosts: [1, 2], wanted: new Map(),
		busy: new Set(), retryAt: new Map(), counter: 0, ...extra,
	};
}

const want = (key: string, trigger: Trigger = "birth") => new Map([[key, trigger]]);
const actions = (w: World, f: Facts) => planTiles(w, f).actions;

test("§6.2: a tile without an instance gets one; a stopped tile with no start wanted gets nothing", () => {
	assert.deepEqual(actions(world([{ x: -1 }]), facts([])), [{ kind: "create", key: "-1,0" }]);
	const stopped = world([{ instanceId: 4 }]);
	assert.deepEqual(planTiles(stopped, facts([inst(4, "stopped", 1, true)])), {
		tiles: [], counter: 0, actions: [], notes: [], unwant: [], drop: false,
	}, "GW never restarts a tile");
});

test("§6.2 a wanted start: assign round-robin, create the save from the seed, then start naming no save", () => {
	const w = world([{ x: -1, instanceId: 4 }]);
	let plan = planTiles(w, facts([inst(4, "unassigned", null)], { wanted: want("-1,0"), counter: 3 }));
	assert.deepEqual([plan.actions, plan.counter, plan.unwant], [
		[{ kind: "assign", key: "-1,0", instanceId: 4, host: 2 }], 4, [],
	], "hosts[3 mod 2]; the want waits for the next step");
	plan = planTiles(w, facts([inst(4, "stopped", 1, false)], { wanted: want("-1,0") }));
	assert.deepEqual([plan.actions, plan.unwant], [
		[{ kind: "createSave", key: "-1,0", instanceId: 4, save: "gridworld_-1_0.zip" }], [],
	], "no save listed: gridworld_-1_0.zip from the seed");
	plan = planTiles(w, facts([inst(4, "stopped", 1, true)], { wanted: want("-1,0", "join") }));
	assert.deepEqual([plan.actions, plan.unwant], [
		[{ kind: "start", key: "-1,0", instanceId: 4, trigger: "join" }], ["-1,0"],
	], "a listed save: a start that names none, and no new save");
	for (const status of ["starting", "running"]) {
		plan = planTiles(w, facts([inst(4, status, 1, true)], { wanted: want("-1,0") }));
		assert.deepEqual([plan.actions, plan.unwant], [[], ["-1,0"]], `${status}: the want is met`);
	}
	for (const status of ["stopping", "creating_save", "exporting_data"]) {
		plan = planTiles(w, facts([inst(4, status, 1, true)], { wanted: want("-1,0") }));
		assert.deepEqual([plan.actions, plan.unwant], [[], []], `${status}: the want waits`);
	}
});

test("§8 preconditions: no_hosts and host_offline drop the want and log start_skipped", () => {
	const w = world([{ instanceId: 4 }]);
	let plan = planTiles(w, facts([inst(4, "unassigned", null)], { wanted: want("0,0"), hosts: [] }));
	assert.deepEqual([plan.actions, plan.unwant], [[], ["0,0"]]);
	assert.deepEqual([plan.notes[0].phase, plan.notes[0].level, plan.notes[0].fields.reason], [
		"start_skipped", "warn", "no_hosts",
	]);
	plan = planTiles(w, facts([inst(4, "unknown", 2, true)], { wanted: want("0,0") }));
	assert.deepEqual([plan.actions, plan.unwant, plan.notes[0].fields.reason], [[], ["0,0"], "host_offline"]);
});

test("round-robin: every connected host sorted by id, in turn, the counter carried from pass to pass", () => {
	const hosts = [
		{ id: 4, connected: true, publicAddress: "" },
		{ id: 2, connected: true, publicAddress: "" },
		{ id: 3, connected: false, publicAddress: "" },
	];
	assert.deepEqual(connectedHosts(hosts), [2, 4], "no plugin filter, and a disconnected host is skipped");
	const w = world([0, 1, 2].map(x => ({ x, instanceId: 10 + x })));
	const unplaced = [10, 11, 12].map(id => inst(id, "unassigned", null));
	const wanted = new Map<string, Trigger>([["0,0", "birth"], ["1,0", "join"], ["2,0", "join"]]);
	const plan = planTiles(w, facts(unplaced, { wanted, hosts: [2, 4], counter: 1 }));
	assert.deepEqual(plan.actions.map(a => (a.kind === "assign" ? a.host : 0)), [4, 2, 4]);
	assert.equal(plan.counter, 4);
});

test("missing: with a start wanted, an absent instance is cleared and replanned; with none, nothing changes", () => {
	const w = world([{ x: 1, instanceId: 9 }]);
	assert.deepEqual(planTiles(w, facts([])).tiles, [], "no want: nothing is replaced");
	const plan = planTiles(w, facts([], { wanted: want("1,0", "join") }));
	assert.equal(plan.tiles.length, 1);
	assert.equal(plan.tiles[0].instanceId, undefined, "instanceId cleared");
	assert.deepEqual(plan.notes.map(n => [n.phase, n.level]), [["instance_missing", "error"], ["planned", "info"]]);
	assert.deepEqual([plan.notes[0].fields.instance, plan.notes[1].fields.reason, plan.unwant], [9, "missing", []]);
	assert.deepEqual(plan.actions, [{ kind: "create", key: "1,0" }], "the create follows the write, not a later pass");
	const next = world([{ x: 1 }]);
	assert.deepEqual(actions(next, facts([], { wanted: want("1,0", "join") })), [{ kind: "create", key: "1,0" }]);
	const back = planTiles(w, facts([inst(9, "stopped", 1, true)], { wanted: want("1,0", "join") }));
	assert.deepEqual(back.actions, [{ kind: "start", key: "1,0", instanceId: 9, trigger: "join" }], "it came back");
});

test("growth: a join plans the missing orthogonal neighbours and wants all 4; a non-tile's join does nothing", () => {
	const w = world([{ instanceId: 4 }, { x: 1, instanceId: 5 }]);
	assert.deepEqual(growth(w, 4), {
		plan: [[0, -1], [0, 1], [-1, 0]],
		want: ["0,-1", "1,0", "0,1", "-1,0"],
	});
	assert.deepEqual(growth(w, 99), { plan: [], want: [] }, "not a tile's instance");
	assert.deepEqual(growth(world([{ instanceId: 4 }], { deleting: true }), 4), { plan: [], want: [] });
	assert.deepEqual(growth(null, 4), { plan: [], want: [] });
});

test("deletion by name: every gridworld_* and pathworld instance is stopped, then deleted; the record last", () => {
	const deleting = world([{ instanceId: 1 }], { deleting: true });
	const found = [
		inst(1, "running", 1, true, "gridworld_0_0"), inst(2, "stopped", 1, true, "gridworld_1_0"),
		inst(3, "unknown", 2, true, "gridworld_extra"), inst(4, "unassigned", null, false, "pathworld"),
		inst(5, "stopping", 1, true, "gridworld_2_0"), inst(6, "running", 1, true, "lobby"),
		inst(7, "running", 1, true, "pathworld2"),
	];
	const plan = planTiles(deleting, facts(found, { wanted: want("0,0") }));
	assert.deepEqual(plan.actions.map(a => `${a.kind} ${a.key}`), ["stop i1", "delete i2", "assign i3", "delete i4"]);
	assert.deepEqual((plan.actions[2] as Action & { host: null }).host, null, "unassigned first: its host is offline");
	assert.equal(plan.drop, false);
	assert.deepEqual([plan.tiles, plan.unwant], [[], []], "no tile rows while deleting");
	assert.equal(planTiles(deleting, facts([found[5], found[6]])).drop, true, "only other names are left, untouched");
	assert.equal(planTiles(deleting, facts([], { busy: new Set(["0,0"]) })).drop, false, "an action is in flight");
	assert.ok(deletedByName("gridworld_") && !deletedByName("Gridworld_0_0") && !deletedByName("gridworld"));
});

test("the backoff, and in-flight keys: a blocked key gets no action until its time has come", () => {
	const w = world([{}]);
	assert.deepEqual(actions(w, facts([], { retryAt: new Map([["0,0", NOW + 1]]) })), [], "backing off");
	assert.deepEqual(actions(w, facts([], { retryAt: new Map([["0,0", NOW]]) })), [{ kind: "create", key: "0,0" }]);
	assert.deepEqual(actions(w, facts([], { busy: new Set(["0,0"]) })), [], "an action in flight");
	const deleting = world([], { deleting: true });
	const running = [inst(1, "running", 1, true, "gridworld_0_0")];
	assert.deepEqual(actions(deleting, facts(running, { busy: new Set(["i1"]) })), [], "its instance is busy");
	assert.deepEqual(actions(deleting, facts(running, { retryAt: new Map([["i1", NOW + 1]]) })), []);
});
