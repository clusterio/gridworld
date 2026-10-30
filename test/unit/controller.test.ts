import { test } from "node:test";
import assert from "node:assert/strict";
import { DaytimeAnchorEvent, TogglesEvent, type WorldFile } from "../../world/contracts.js";
import { Reconciler } from "../../world/reconciler.js";
import { fakeLogger, phases, settle, setup } from "./fakes.js";

const count = (calls: string[], name: string) => calls.filter(c => c.startsWith(`${name} `)).length;

test("birth: created, the id persisted only after saveData(), then placed, saved from the seed, started", async () => {
	const { cluster, store, disk, reconciler, lines } = setup();
	await store.createWorld({ tileSize: 64 });
	const release = cluster.gateSaveData();
	reconciler.trigger();
	await settle();
	assert.deepEqual(cluster.calls, ["create 101 0,0", "saveData"]);
	assert.equal(store.world?.tiles["0,0"].instanceId, undefined, "no id before Clusterio's record is on disk");
	// Clusterio fires instanceStatusChanged for the new instance at once; that pass must leave the busy tile alone.
	await reconciler.onStatus({ id: 101, status: "unassigned" });
	await settle();
	assert.equal(store.world?.tiles["0,0"].instanceId, undefined);
	assert.deepEqual(cluster.calls, ["create 101 0,0", "saveData"], "nothing else acts meanwhile");
	release();
	await settle();
	assert.equal((disk.at(-1) as WorldFile).world?.tiles["0,0"].instanceId, 101, "written");
	assert.deepEqual(cluster.calls.slice(2), ["assign 101 1", "createSave 101 gridworld_0_0.zip", "start 101"]);
	assert.deepEqual(phases(lines, "gw.tile"), ["planned", "instance_created", "placed", "save_created", "starting"]);
	assert.equal(lines.find(l => l.meta.phase === "starting")?.meta.reason, "birth");
	const trace = store.world!.tiles["0,0"].trace;
	assert.deepEqual(reconciler.statuses(), [{ x: 0, y: 0, instanceId: 101, host: 1, status: "running", trace }]);
});

test("GW never restarts a tile; a join next door plans its neighbours and starts all 4 from their saves", async () => {
	const { cluster, store, reconciler, lines } = setup();
	await reconciler.createWorld({ tileSize: 64 });
	await reconciler.createTile(1, 0);
	await settle();
	assert.deepEqual([cluster.instances.get(101)?.status, cluster.instances.get(102)?.status], ["running", "running"]);
	cluster.instances.get(101)!.status = "stopped";
	await reconciler.onStatus({ id: 101, status: "stopped" });
	reconciler.trigger();
	await settle();
	assert.equal(count(cluster.calls, "start"), 2, "a crashed tile stays down");
	await reconciler.onPlayerJoin(999);
	await settle();
	assert.equal(Object.keys(store.world!.tiles).length, 2, "a join on an instance that isn't a tile's does nothing");
	await reconciler.onPlayerJoin(102);
	await settle();
	assert.deepEqual(Object.keys(store.world!.tiles).sort(), ["0,0", "1,-1", "1,0", "1,1", "2,0"]);
	assert.equal(cluster.instances.get(101)?.status, "running", "(0,0) started again");
	assert.equal(count(cluster.calls, "createSave"), 5, "no second save for (0,0): its host lists one");
	const starts = lines.filter(l => l.meta.phase === "starting").map(l => `${l.meta.x},${l.meta.y} ${l.meta.reason}`);
	assert.deepEqual(starts.slice(2).sort(), ["0,0 join", "1,-1 join", "1,1 join", "2,0 join"]);
	const planned = lines.filter(l => l.meta.phase === "planned" && l.meta.reason === "join");
	assert.equal(planned.length, 3);
});

test("a missing instance is replaced only when a start is wanted: a new instance, a save from the seed", async () => {
	const { cluster, store, reconciler, lines, edges } = setup();
	await reconciler.createWorld({ tileSize: 64 });
	await reconciler.createTile(1, 0);
	await settle();
	const id = `gridworld:${store.world!.id}:0,0:1,0:101,102`;
	assert.equal(edges.records.get(id)?.deleted, false);
	cluster.instances.get(102)!.status = "stopped";
	cluster.instances.delete(102);
	await reconciler.onStatus({ id: 102, status: "deleted" });
	await settle();
	assert.equal(store.world?.tiles["1,0"].instanceId, 102, "no start wanted: nothing is replaced");
	assert.ok(!lines.some(l => l.meta.phase === "instance_missing"));
	assert.equal(edges.records.get(id)?.deleted, true, "its edge goes with it");
	await reconciler.onPlayerJoin(101);
	await settle();
	const missing = lines.find(l => l.meta.phase === "instance_missing");
	assert.deepEqual([missing?.level, missing?.meta.instance, missing?.meta.x], ["error", 102, 1]);
	const fresh = store.world!.tiles["1,0"].instanceId!;
	assert.ok(fresh > 102, "a new instance");
	assert.equal(cluster.instances.get(fresh)?.status, "running");
	assert.ok(cluster.calls.includes(`createSave ${fresh} gridworld_1_0.zip`), "a fresh map from the seed");
	assert.ok(lines.some(l => l.meta.phase === "planned" && l.meta.reason === "missing" && l.meta.x === 1));
	const replaced = `gridworld:${store.world!.id}:0,0:1,0:101,${fresh}`;
	assert.equal(edges.records.get(replaced)?.deleted, false, "a new edge");
});

test("a missing instance is replaced at once, even when the join plans no new neighbour to wake the loop", async () => {
	const { cluster, store, reconciler } = setup();
	await reconciler.createWorld({ tileSize: 64 });
	for (const [x, y] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
		await reconciler.createTile(x, y);
	}
	await settle(60);
	cluster.instances.delete(102);
	await reconciler.onStatus({ id: 102, status: "deleted" });
	await reconciler.onPlayerJoin(101);
	await settle(60);
	const fresh = store.world!.tiles["1,0"].instanceId;
	assert.ok(fresh !== undefined && fresh > 105, `a new instance without another trigger (got ${fresh})`);
	assert.equal(cluster.instances.get(fresh)?.status, "running");
});

test("a steady pass plans no edges: UE's list is read again only after a tile, an instance or UE changed", async () => {
	const { cluster, reconciler, edges } = setup();
	await reconciler.createWorld({ tileSize: 64 });
	await reconciler.createTile(1, 0);
	await settle();
	let lists = 0;
	const list = edges.api.list;
	edges.api.list = filter => {
		lists += 1;
		return list(filter);
	};
	reconciler.trigger();
	await settle();
	assert.equal(lists, 0, "nothing changed");
	edges.emit({ kind: "purged", id: "gridworld:gone" });
	await settle();
	assert.equal(lists, 1, "UE purged a gridworld edge");
	cluster.instances.delete(102);
	await reconciler.onStatus({ id: 102, status: "deleted" });
	await settle();
	assert.equal(lists, 2, "a tile's instance went");
	reconciler.trigger();
	await settle();
	assert.equal(lists, 2, "steady again");
});

test("a controller restart: a new reconciler has no start wants, and its counter is at the first host", async () => {
	const { cluster, store, reconciler } = setup();
	await reconciler.createWorld({ tileSize: 64 });
	await settle();
	assert.equal(cluster.instances.get(101)?.host, 1);
	cluster.instances.get(101)!.status = "stopped";
	const restarted = new Reconciler(store, cluster.port, fakeLogger());
	await restarted.createTile(1, 0);
	await settle();
	assert.equal(cluster.instances.get(102)?.host, 1, "placement restarts at the first host, as v1's did");
	assert.equal(cluster.instances.get(101)?.status, "stopped", "no start wanted survives a restart");
});

test("a failed step of a start drops its want and isn't retried; another failed action backs off", async () => {
	let now = 1_000_000;
	const { cluster, reconciler, lines } = setup(() => now);
	cluster.failing.add("start");
	await reconciler.createWorld({ tileSize: 64 });
	await settle();
	const failed = lines.find(l => l.meta.phase === "action_failed");
	assert.deepEqual([failed?.level, failed?.meta.action, failed?.meta.error], ["warn", "start", "start failed"]);
	cluster.failing.clear();
	reconciler.trigger();
	await settle();
	assert.equal(count(cluster.calls, "start"), 1, "not retried: the want is gone");
	cluster.failing.add("create");
	await reconciler.createTile(1, 0);
	await settle();
	cluster.failing.clear();
	reconciler.trigger();
	await settle();
	assert.equal(count(cluster.calls, "create"), 2, "backing off: no retry yet");
	assert.equal(lines.filter(l => l.meta.phase === "action_failed").at(-1)?.meta.failures, 1);
	now += 10_001;
	reconciler.trigger();
	await settle();
	assert.equal(count(cluster.calls, "create"), 3, "retried once the backoff ran out");
	assert.equal(cluster.instances.get(103)?.status, "running", "and started at birth");
});

test("deletion by name: every gridworld_* instance, a stray too, is stopped and deleted, then the record", async () => {
	const { cluster, store, reconciler, lines } = setup();
	await reconciler.createWorld({ tileSize: 64 });
	await settle();
	cluster.instances.set(50, { id: 50, name: "gridworld_extra", status: "unassigned", host: null, hasSave: false });
	cluster.instances.set(51, { id: 51, name: "lobby", status: "running", host: 1, hasSave: true });
	await reconciler.deleteWorld();
	await settle();
	const removals = cluster.calls.filter(c => /^(stop|delete) /.test(c));
	assert.deepEqual(removals.sort(), ["delete 101", "delete 50", "stop 101"]);
	assert.equal(store.world, null, "the record went once none was left");
	assert.equal(cluster.instances.get(51)?.status, "running", "other names are never touched");
	const swept = lines.filter(l => l.meta.op === "gw.world" && String(l.meta.phase).startsWith("instance_"))
		.map(l => `${l.meta.phase} ${l.meta.instance} ${l.meta.name}`);
	assert.deepEqual(swept.sort(), [
		"instance_deleted 101 gridworld_0_0",
		"instance_deleted 50 gridworld_extra",
		"instance_stopped 101 gridworld_0_0",
	], "each instance the deletion takes is logged by id and name");
});

test("the anchor goes to a tile at every transition to running, and hourly to every running tile", async () => {
	const { cluster, store, reconciler } = setup();
	const world = await store.createWorld({ tileSize: 64, ticksPerDay: 30000 });
	await store.createTile(1, 0, "tile_create");
	reconciler.trigger();
	await settle();
	const anchors = () => cluster.sent.filter(s => s.event instanceof DaytimeAnchorEvent);
	await reconciler.onStatus({ id: 101, status: "running" });
	await reconciler.onStatus({ id: 102, status: "running" });
	assert.deepEqual(anchors().map(a => a.to), [101, 102]);
	const a = anchors()[0].event as DaytimeAnchorEvent;
	assert.deepEqual([a.epochMs, a.epochDaytime, a.ticksPerDay], [world.epochMs, 0, 30000]);
	await reconciler.onStatus({ id: 101, status: "running" });
	assert.equal(anchors().length, 3, "unknown → running after a controller restart counts");
	cluster.instances.get(102)!.status = "stopped";
	reconciler.broadcastAnchors();
	assert.deepEqual(anchors().slice(3).map(x => x.to), [101], "hourly: the running tiles only");
});

test("the biter toggles go to a tile at every start, to every running tile when a gridworld field changes, and hourly",
	async () => {
		const { cluster, store, reconciler } = setup();
		await store.createWorld({ tileSize: 64 });
		await store.createTile(1, 0, "tile_create");
		reconciler.trigger();
		await settle();
		const sent = () => cluster.sent.filter(s => s.event instanceof TogglesEvent)
			.map(s => [s.to, (s.event as TogglesEvent).toggles.cross_border_raids]);
		await reconciler.onStatus({ id: 101, status: "running" });
		assert.deepEqual(sent(), [[101, true]], "a start gets them");
		cluster.toggles.cross_border_raids = false;
		reconciler.onControllerConfig("gridworld.cross_border_raids");
		assert.deepEqual(sent().slice(1), [[101, false], [102, false]], "a change: every running tile, at once");
		reconciler.onControllerConfig("controller.name");
		assert.equal(sent().length, 3, "another plugin's field sends nothing");
		cluster.instances.get(102)!.status = "stopped";
		reconciler.onControllerConfig("gridworld.shared_evolution");
		assert.deepEqual(sent().slice(3).map(([to]) => to), [101], "the running tiles only");
		reconciler.broadcastAnchors();
		assert.deepEqual(sent().slice(4), [[101, false]], "hourly, with the anchor: the running tiles, as now");
	});

test("a corner zone's crossing names the diagonal tile's instance, or why not (crossing spec §7.2)", async () => {
	const { cluster, store, reconciler } = setup();
	await store.createWorld({ tileSize: 64 });
	await store.createTile(1, 1, "tile_create");
	reconciler.trigger();
	await settle();
	const d = cluster.instances.get(102)!;
	assert.equal(reconciler.crossing(101, "gridworld:se"), d.id);
	assert.equal(reconciler.crossing(101, "gridworld:nw"), "no_tile");
	assert.equal(reconciler.crossing(101, "gridworld:xx"), "unknown_corner");
	assert.equal(reconciler.crossing(101, "gridworld:toString"), "unknown_corner", "an inherited name is no corner");
	assert.equal(reconciler.crossing(999, "gridworld:se"), "not_a_tile");
});

const FIVE = ["aquilo", "fulgora", "gleba", "nauvis", "vulcanus"];

test("surfaces §4.1: a tile's report is stored sorted and logged once; its pair's planet edges follow both reports; " +
	"a planet gone from one tile's report loses that pair's edge, and only that one (Review Focus 2)", async () => {
	const { store, reconciler, lines, edges, disk } = setup();
	await reconciler.createWorld({ tileSize: 64 });
	await reconciler.createTile(1, 0);
	await settle();
	const id = (planet: string) => `gridworld:${store.world!.id}:${planet}:0,0:1,0:101,102`;
	const nauvis = `gridworld:${store.world!.id}:0,0:1,0:101,102`;
	const told = () => lines.filter(l => l.meta.op === "gw.tile" && l.meta.phase === "planets");
	const touched = store.world!.tiles["0,0"].updatedAtMs;
	await reconciler.onPlanets(101, ["vulcanus", "nauvis", "gleba", "fulgora", "aquilo"]);
	await settle();
	assert.deepEqual(store.world!.tiles["0,0"].planets, FIVE, "stored sorted");
	assert.ok(store.world!.tiles["0,0"].updatedAtMs > touched, "the tile is touched");
	assert.deepEqual((disk.at(-1) as WorldFile).world?.tiles["0,0"].planets, FIVE, "and written");
	assert.deepEqual([told().length, told()[0]?.meta.instance, told()[0]?.meta.planets], [1, 101, FIVE]);
	assert.ok(!edges.records.has(id("vulcanus")), "one tile's report is no agreement");
	await reconciler.onPlanets(102, FIVE);
	await settle();
	for (const planet of ["aquilo", "fulgora", "gleba", "vulcanus"]) {
		assert.equal(edges.records.get(id(planet))?.deleted, false, `${planet}'s edge ensured`);
	}
	assert.equal(edges.records.get(nauvis)?.deleted, false, "Nauvis keeps SP2's id, live");
	const writes = disk.length;
	await reconciler.onPlanets(101, [...FIVE].reverse());
	await reconciler.onPlanets(999, FIVE);
	await settle();
	assert.equal(disk.length, writes, "an equal repeat in another order, or a sender that is no tile, writes nothing");
	assert.equal(told().length, 2, "and logs nothing");
	assert.deepEqual(reconciler.statuses().map(s => s.planets), [FIVE, FIVE]);
	await reconciler.onPlanets(102, FIVE.filter(p => p !== "gleba"));
	await settle();
	assert.equal(edges.records.get(id("gleba"))?.deleted, true, "Gleba's edge goes");
	for (const planet of ["aquilo", "fulgora", "vulcanus"]) {
		assert.equal(edges.records.get(id(planet))?.deleted, false, `${planet}'s stays`);
	}
	assert.equal(edges.records.get(nauvis)?.deleted, false, "and Nauvis's");
});

test("balancer hand-off (§8): a moving tile isn't started; the move's end runs a pass that starts it", async () => {
	const { cluster, reconciler, balancer } = setup();
	await reconciler.createWorld({ tileSize: 64 });
	await reconciler.createTile(1, 0);
	await settle();
	const starts = () => cluster.calls.filter(c => c === "start 102").length;
	assert.equal(starts(), 1, "(1,0) was born running");
	cluster.instances.get(102)!.status = "stopped"; // the balancer stopped it to move it
	balancer.moving.add(102);
	await reconciler.onPlayerJoin(101); // a join on (0,0) wants (1,0) started
	await settle();
	assert.equal(starts(), 1, "not while it moves");
	balancer.moving.delete(102);
	balancer.finish(102);
	await settle();
	assert.equal(starts(), 2, "the move's end ran a pass, which started it");
});

test("without the balancer, gridworld warns once and plans as before (balancer spec §8)", async () => {
	const { cluster, reconciler, lines } = setup();
	cluster.balancerSlot.api = undefined;
	await reconciler.createWorld({ tileSize: 64 });
	await settle();
	reconciler.trigger();
	await settle();
	assert.equal(lines.filter(l => l.message.startsWith("gw.balancer")).length, 1);
	assert.equal(cluster.instances.get(101)?.status, "running", "the birth went ahead");
});

test("placement skips a host the balancer doesn't accept (balancer spec §8, memory amendment §3.6)", async () => {
	const { cluster, reconciler, balancer } = setup();
	balancer.refused.add(1);
	await reconciler.createWorld({ tileSize: 64 });
	await reconciler.createTile(1, 0);
	await settle();
	assert.deepEqual(cluster.calls.filter(c => c.startsWith("assign ")).sort(), ["assign 101 2", "assign 102 2"]);
});

test("with no host accepted, a start is skipped as no_hosts (memory amendment §3.6)", async () => {
	const { cluster, reconciler, balancer, lines } = setup();
	balancer.refused.add(1);
	balancer.refused.add(2);
	await reconciler.createWorld({ tileSize: 64 });
	await settle();
	assert.deepEqual(cluster.calls.filter(c => c.startsWith("assign ")), [], "nothing placed");
	assert.ok(lines.some(l => l.meta.op === "gw.tile" && l.meta.phase === "start_skipped"
		&& l.meta.reason === "no_hosts"), "logged gw.tile start_skipped no_hosts");
});
