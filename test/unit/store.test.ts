import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as lib from "@clusterio/lib";
import { loadDataFile, saveDataFile } from "universal_edges/runtime";
import type { Layout, World, WorldFile } from "../../world/contracts.js";
import { desiredEdges } from "../../world/grid.js";
import { planEdges } from "../../world/plan.js";
import { WorldStore, fileData } from "../../world/store.js";
import { fakeLogger, settle, type Line } from "./fakes.js";

/** A store whose writes land in `disk`, or go through `save`; it records what it published and logged. */
function open(data?: WorldFile, save?: (d: WorldFile) => Promise<void>, now?: () => number) {
	const disk: WorldFile[] = [];
	const layouts: Layout[] = [];
	const lines: Line[] = [];
	const store = new WorldStore(data ?? fileData(undefined), {
		save: save ?? (async d => {
			disk.push(structuredClone(d));
		}),
		published: layout => {
			layouts.push(layout);
		},
	}, fakeLogger(lines), now);
	return { store, disk, layouts, lines };
}

test("create checks the tile size and the day length, defaults both, and plans tile (0,0)", async () => {
	const { store, lines } = open();
	for (const tileSize of [0, 32, 100, 4160, 512.5]) {
		await assert.rejects(store.createWorld({ tileSize }), /multiple of 64 from 64 to 4096/, String(tileSize));
	}
	await assert.rejects(store.createWorld({ ticksPerDay: 1199 }), /at least 1200/);
	await assert.rejects(
		store.createWorld({ exclude: ["gleba", "nauvis"] }), /base planet nauvis can't be excluded/,
	);
	await assert.rejects(store.createWorld({ mapExchangeString: "not one" }), /map exchange string/);
	assert.equal(store.world, null, "a refused create leaves no world");
	const world = await store.createWorld({});
	assert.deepEqual(
		[world.tileSize, world.ticksPerDay, world.surface, world.epochDaytime, world.deleting],
		[512, 25000, "nauvis", 0, false],
	);
	assert.ok(Number.isInteger(world.seed) && world.seed >= 0 && world.seed < 2 ** 32, "a random uint32 seed");
	assert.deepEqual(Object.keys(world.tiles), ["0,0"]);
	assert.notEqual(world.tiles["0,0"].trace, world.trace, "the tile has its own trace");
	assert.ok(lines.some(l => l.meta.phase === "planned" && l.meta.reason === "world"), "planned with its reason");
});

test("create checks a given seed and uses it (the web page's and ctl's seed field)", async () => {
	const { store } = open();
	for (const seed of [-1, 2 ** 32, 1.5]) {
		await assert.rejects(
			store.createWorld({ seed }), /seed .* must be an integer from 0 to 4294967295/, String(seed),
		);
	}
	assert.equal((await store.createWorld({ tileSize: 64, seed: 4294967295 })).seed, 4294967295);
});

test("create is refused while a world exists, deleting or not; a dropped world makes way for a new one", async () => {
	const { store, disk } = open();
	const world = await store.createWorld({ tileSize: 64 });
	await assert.rejects(store.createWorld({}), /exists/);
	await store.deleteWorld();
	assert.equal(store.world?.deleting, true);
	await assert.rejects(store.createWorld({}), /exists/, "still refused while deleting");
	const writes = disk.length;
	await store.deleteWorld();
	assert.equal(disk.length, writes, "deleting twice writes nothing new");
	await store.dropWorld();
	assert.deepEqual(disk.at(-1), { world: null });
	await assert.rejects(store.deleteWorld(), /no world/);
	assert.ok((await store.createWorld({ tileSize: 64 })).id !== world.id, "a new world can be created");
});

test("each refusal is the error class its requester gets: bad input, no world, or a world in the way", async () => {
	const { store } = open();
	await assert.rejects(store.deleteWorld(), lib.NotFoundError);
	await assert.rejects(store.createTile(0, 0, "tile_create"), lib.NotFoundError);
	const refused = [
		{ tileSize: 100 }, { ticksPerDay: 1199 }, { exclude: ["nauvis"] }, { mapExchangeString: "not one" },
		{ seed: -1 },
	];
	for (const opts of refused) {
		await assert.rejects(store.createWorld(opts), lib.ValidationError, JSON.stringify(opts));
	}
	await store.createWorld({ tileSize: 64 });
	await assert.rejects(store.createWorld({}), lib.ConflictError);
	await store.deleteWorld();
	await assert.rejects(store.createTile(1, 0, "tile_create"), lib.ConflictError);
});

test("the file: absent is an empty record, malformed throws, and a world survives a reload", async () => {
	assert.deepEqual(fileData(undefined), { world: null });
	assert.throws(() => fileData({ world: 5 }), /malformed/);
	const file = join(await mkdtemp(join(tmpdir(), "gw-store-")), "gridworld_world.json");
	const { store } = open(undefined, d => saveDataFile(file, [], d));
	await store.createWorld({ tileSize: 64 });
	await store.createTile(-1, 0, "tile_create");
	const raw = JSON.parse(await readFile(file, "utf8"));
	assert.equal(raw.schema, 1);
	assert.deepEqual(Object.keys(raw.data), ["world"]);
	assert.deepEqual(Object.keys(fileData(await loadDataFile(file, [])).world?.tiles ?? {}), ["0,0", "-1,0"]);
});

test("persist, then act: nothing resolves, is logged or is published before the write", async () => {
	let release!: () => void;
	const gate = new Promise<void>(resolve => {
		release = resolve;
	});
	const { store, layouts, lines } = open(undefined, () => gate);
	let done = false;
	const created = store.createWorld({ tileSize: 64 }).then(() => {
		done = true;
	});
	await settle();
	assert.equal(done, false);
	assert.equal(layouts.length, 0, "no layout event");
	assert.equal(lines.length, 0, "no log line");
	let waited = false;
	const nothingNew = store.save().then(() => {
		waited = true;
	});
	await settle();
	assert.equal(waited, false, "a save with nothing new waits for the write in progress");
	release();
	await created;
	await nothingNew;
	assert.equal(layouts.length, 1);
	assert.deepEqual(lines.map(l => l.meta.phase), ["created", "planned"]);
});

test("a failed write rejects its callers, and the next write carries the change", async () => {
	let fail = true;
	const disk: WorldFile[] = [];
	const { store, layouts } = open(undefined, async d => {
		if (fail) {
			throw new Error("disk full");
		}
		disk.push(structuredClone(d));
	});
	await assert.rejects(store.createWorld({ tileSize: 64 }), /disk full/);
	assert.equal(layouts.length, 0, "nothing published for a failed write");
	await assert.rejects(store.createTile(1, 0, "tile_create"), /disk full/);
	fail = false;
	assert.equal(await store.createTile(1, 0, "tile_create"), false, "planned already");
	assert.deepEqual(Object.keys(disk.at(-1)?.world?.tiles ?? {}), ["0,0", "1,0"], "the retry wrote both");
	assert.deepEqual(layouts.at(-1)?.tiles.map(t => [t.x, t.y]), [[0, 0], [1, 0]], "published when it landed");
});

test("the layout: events carry only changed tiles; a subscriber gets those after its time, all for 0", async () => {
	const { store, layouts } = open();
	await store.createWorld({ tileSize: 64 });
	const first = store.world!.tiles["0,0"].updatedAtMs;
	assert.equal(await store.createTile(1, 0, "tile_create"), true);
	assert.deepEqual(layouts.at(-1)?.tiles.map(t => [t.x, t.y, ...t.bounds]), [[1, 0, 32, -32, 96, 32]]);
	assert.equal(layouts.at(-1)?.world?.tileSize, 64, "the header always comes");
	assert.deepEqual(store.layout(first).tiles.map(t => [t.x, t.y]), [[1, 0]]);
	assert.equal(store.layout(0).tiles.length, 2);
	await store.deleteWorld();
	assert.equal(layouts.at(-1)?.world?.deleting, true);
	await store.dropWorld();
	assert.deepEqual(layouts.at(-1), { world: null, tiles: [] }, "a dropped world empties the layout");
});

test("tile create refuses a missing or deleting world, and leaves a planned tile as it is", async () => {
	const { store, lines } = open();
	await assert.rejects(store.createTile(1, 0, "tile_create"), /no world/);
	await store.createWorld({ tileSize: 64 });
	assert.equal(await store.createTile(-1, 0, "join"), true);
	assert.equal(await store.createTile(-1, 0, "tile_create"), false, "planned already");
	assert.deepEqual(lines.filter(l => l.meta.phase === "planned").map(l => l.meta.reason), ["world", "join"]);
	await store.deleteWorld();
	await assert.rejects(store.createTile(1, 0, "tile_create"), /being deleted/);
});

test("stamps stay above every stored one after a reload, even when the clock went back", async () => {
	const { store } = open();
	await store.createWorld({ tileSize: 64 });
	const stored = structuredClone(store.data);
	stored.world!.tiles["0,0"].updatedAtMs = 5_000_000;
	const reloaded = open(stored, undefined, () => 1000).store;
	await reloaded.createTile(1, 0, "tile_create");
	assert.ok(reloaded.world!.tiles["1,0"].updatedAtMs > 5_000_000);
	assert.deepEqual(reloaded.layout(5_000_000).tiles.map(t => [t.x, t.y]), [[1, 0]], "a subscriber's replay sees it");
});

const FIVE = ["aquilo", "fulgora", "gleba", "nauvis", "vulcanus"];

test("the world upgrade (surfaces §5): a pre-planets world file loads unmigrated and keeps its Nauvis edges", () => {
	const tile = (x: number, y: number, instanceId: number) => ({
		x, y, instanceId, trace: `t${x},${y}`, createdAtMs: 1, updatedAtMs: 1,
	});
	const file = {
		world: {
			id: "3f9c1a2b.1", trace: "w", createdAtMs: 1, tileSize: 512, surface: "nauvis", seed: 7, ticksPerDay: 30000,
			epochMs: 1, epochDaytime: 0, deleting: false,
			tiles: { "0,0": tile(0, 0, 12), "1,0": tile(1, 0, 13), "0,1": tile(0, 1, 14) },
		},
	};
	const world: World = fileData(structuredClone(file)).world!;
	assert.deepEqual<World>(world, file.world, "loaded as it is: WORLD_MIGRATIONS stays empty (§5.1)");
	const before = desiredEdges(world, () => true);
	assert.deepEqual(before.map(s => s.id).sort(), [
		"gridworld:3f9c1a2b.1:0,0:0,1:12,14", "gridworld:3f9c1a2b.1:0,0:1,0:12,13",
	], "the pre-upgrade Nauvis ids exactly");
	const records = before.map(
		s => ({ ...s, revision: 3, deleted: false, connectors: [], trace: "ue", updatedAtMs: 1 }),
	);
	assert.deepEqual(planEdges(desiredEdges(world, () => true), records), { ensure: [], remove: [], rejected: [] });
	world.tiles["0,0"].planets = FIVE;
	world.tiles["1,0"].planets = FIVE;
	const plan = planEdges(desiredEdges(world, () => true), records);
	assert.equal(plan.remove.length + plan.rejected.length, 0, "no Nauvis edge is removed or rejected");
	assert.deepEqual(plan.ensure.map(s => s.id).sort(), ["aquilo", "fulgora", "gleba", "vulcanus"]
		.map(p => `gridworld:3f9c1a2b.1:${p}:0,0:1,0:12,13`), "four for the pair that both report the five");
});

test("surfaces §4.2: create stores a non-empty exclude list, frozen with the world; 1200 ticks is the " +
	"shortest day (S6)", async () => {
	const world = await open().store.createWorld({ tileSize: 64, ticksPerDay: 1200, exclude: ["pluto", "gleba"] });
	assert.deepEqual(
		[world.ticksPerDay, world.exclude], [1200, ["pluto", "gleba"]], "a planet the pack lacks is allowed",
	);
	const plain = await open().store.createWorld({ tileSize: 64, exclude: [] });
	assert.ok(!("exclude" in plain), "an empty list isn't stored");
});

test("a controller restart (Review Focus 3): the tiles' planets and the exclude list survive the file, and the " +
	"reloaded world's edge plan changes nothing", async () => {
	const file = join(await mkdtemp(join(tmpdir(), "gw-planets-")), "gridworld_world.json");
	const { store } = open(undefined, d => saveDataFile(file, [], d));
	await store.createWorld({ tileSize: 64, exclude: ["gleba"] });
	await store.createTile(1, 0, "tile_create");
	const w = store.world!;
	for (const [key, id] of [["0,0", 101], ["1,0", 102]] as const) {
		w.tiles[key].instanceId = id;
		w.tiles[key].planets = ["aquilo", "nauvis"];
		store.touch(w.tiles[key]);
	}
	await store.save();
	const reloaded = fileData(await loadDataFile(file, [])).world!;
	assert.deepEqual([reloaded.exclude, reloaded.tiles["1,0"].planets], [["gleba"], ["aquilo", "nauvis"]]);
	const records = desiredEdges(w, () => true).map(s => ({
		...s, revision: 1, deleted: false, connectors: [], trace: "t", updatedAtMs: 0,
	}));
	assert.equal(records.length, 2, "Nauvis's edge and Aquilo's");
	assert.deepEqual(
		planEdges(desiredEdges(reloaded, () => true), records), { ensure: [], remove: [], rejected: [] },
	);
});
