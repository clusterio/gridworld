import { test } from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as lib from "@clusterio/lib";
import { plugin } from "../../index.js";
import {
	DaytimeAnchorEvent, TileCreateRequest, TilePlanetsEvent, TilePlanetsPayload, TogglesEvent, WorldCreateRequest,
	WorldDeleteRequest, WorldLayoutEvent,
} from "../../world/contracts.js";

// Compiled to dist/node/test/unit/; the plugin root is four levels up.
const pluginRoot = join(import.meta.dirname, "..", "..", "..", "..");
const readJson = async (file: string) => JSON.parse(await readFile(join(pluginRoot, file), "utf8"));

test("the declaration names the plugin and its compiled entrypoints exist", async () => {
	assert.equal(plugin.name, "gridworld");
	for (const entry of [plugin.controllerEntrypoint, plugin.instanceEntrypoint, plugin.ctlEntrypoint]) {
		assert.ok(entry, "entrypoint declared");
		await access(join(pluginRoot, entry));
	}
});

test("entrypoints export a default function, the form master loads without a deprecation warning", async () => {
	for (const entry of [plugin.controllerEntrypoint, plugin.instanceEntrypoint, plugin.ctlEntrypoint]) {
		assert.ok(entry, "entrypoint declared");
		const loaded = await import(pathToFileURL(join(pluginRoot, entry)).href);
		assert.equal(typeof loaded.default, "function", entry);
	}
});

test("module.json carries the name and version the save patcher validates", async () => {
	const moduleJson = await readJson(join("module", "module.json"));
	const pkg = await readJson("package.json");
	assert.equal(moduleJson.name, plugin.name);
	assert.equal(moduleJson.version, pkg.version);
});

test("the declaration registers gridworld's 10 messages, its permissions, the gridworld.tile field and the four " +
	"biter toggles, on by default", () => {
	lib.registerPluginMessages([plugin] as unknown as lib.PluginNodeEnvInfo[]);
	lib.registerPluginPermissions([plugin] as unknown as lib.PluginNodeEnvInfo[]);
	const events = [
		"WorldLayoutEvent", "DaytimeAnchorEvent", "TilePlanetsEvent", "EvolutionReportEvent", "EvolutionApplyEvent",
		"TogglesEvent",
	];
	for (const name of events) {
		assert.ok(lib.Link._eventsByName.has(`gridworld:${name}`), name);
	}
	const requests = [
		"WorldCreateRequest", "WorldDeleteRequest", "WorldGetRequest", "TileCreateRequest",
	];
	for (const name of requests) {
		assert.ok(lib.Link._requestsByName.has(`gridworld:${name}`), name);
	}
	assert.equal(plugin.messages?.length, 10);
	assert.ok(lib.permissions.has("gridworld.view") && lib.permissions.has("gridworld.manage"));
	assert.equal(plugin.instanceConfigFields?.["gridworld.tile"]?.type, "object");
	const toggles = Object.entries(plugin.controllerConfigFields ?? {})
		.map(([f, d]) => `${f} ${d.type} ${d.initialValue}`);
	assert.deepEqual(toggles, [
		"gridworld.pollution_border boolean true", "gridworld.cross_border_raids boolean true",
		"gridworld.cross_border_expansion boolean true", "gridworld.shared_evolution boolean true",
	]);
});

test("every message survives the JSON its link carries", () => {
	const roundTrip = (Class: { jsonSchema: object; fromJSON(json: any): unknown }, message: object) => {
		const json = JSON.parse(JSON.stringify(message));
		assert.equal(lib.compile(Class.jsonSchema as any)(json), true, message.constructor.name);
		assert.deepEqual(Class.fromJSON(json), message);
	};
	const layout = { world: { id: "w", tileSize: 64, surface: "nauvis", createdAtMs: 1, deleting: false }, tiles: [] };
	roundTrip(WorldCreateRequest, new WorldCreateRequest(512, undefined, 25000));
	roundTrip(WorldCreateRequest, new WorldCreateRequest(64, undefined, 1200, ["gleba", "pluto"]));
	roundTrip(WorldCreateRequest, new WorldCreateRequest(1024, undefined, undefined, undefined, 123456789));
	roundTrip(WorldDeleteRequest, new WorldDeleteRequest(true));
	roundTrip(TileCreateRequest, new TileCreateRequest(-1, 0));
	roundTrip(WorldLayoutEvent, new WorldLayoutEvent(layout.world, layout.tiles));
	roundTrip(WorldLayoutEvent, new WorldLayoutEvent(null, []));
	roundTrip(DaytimeAnchorEvent, new DaytimeAnchorEvent(1000, 0, 25000, 2000));
	roundTrip(TilePlanetsEvent, new TilePlanetsEvent(["aquilo", "nauvis"]));
	roundTrip(TogglesEvent, new TogglesEvent({
		pollution_border: false, cross_border_raids: true, cross_border_expansion: true, shared_evolution: false,
	}));
});

test("a WorldDeleteRequest without confirm: true fails its schema, from any client (§14)", () => {
	const valid = lib.compile(WorldDeleteRequest.jsonSchema as any);
	assert.equal(valid({ confirm: true }), true);
	assert.equal(valid({}), false, "no confirm");
	assert.equal(valid({ confirm: false }), false, "confirm false");
	assert.equal(valid({ confirm: "yes" }), false, "confirm not a boolean");
});

test("surfaces §4.5: Lua's planet report — each planet's surface, and its day when it has one", () => {
	const valid = lib.compile(TilePlanetsPayload as any);
	assert.equal(valid({ planets: [{ surface: "nauvis", ticksPerDay: 25200 }, { surface: "aquilo" }] }), true);
	assert.equal(valid({ planets: [{ ticksPerDay: 5400 }] }), false, "a planet without a surface");
	assert.equal(valid({ planets: [{ surface: "vulcanus", ticksPerDay: 5400.5 }] }), false, "a day of whole ticks");
});
