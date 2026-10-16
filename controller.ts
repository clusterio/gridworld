import * as path from "node:path";
import * as lib from "@clusterio/lib";
import type { ControllerPluginContext } from "@clusterio/controller";
import { registerCrossingResolver } from "universal_edges/edges";
import { loadDataFile, saveDataFile, type Migration } from "universal_edges/runtime";
import {
	EvolutionApplyEvent, EvolutionReportEvent, TileCreateRequest, WorldCreateRequest, WorldDeleteRequest,
	WorldGetRequest, TilePlanetsEvent, WorldLayoutEvent, type TileConfig,
} from "./world/contracts.js";
import { addReport, advance, newEvolution, parts, type Evolution } from "./world/evolution.js";
import { Reconciler, type Port } from "./world/reconciler.js";
import { WorldStore, fileData } from "./world/store.js";
import { loadBalancerApi, type BalancerApi } from "./world/balancer.js";

/** Migrations of gridworld_world.json ({ world }). Append; never edit one. */
const WORLD_MIGRATIONS: Migration[] = [];
/** §6.3: the pass that covers what raises no event, such as an expired backoff. */
const PASS_MS = 60_000;
/** §11.1: how often every running tile gets the anchor again. */
const ANCHOR_MS = 3_600_000;
/** Cross-border biters spec §8: how often the time part advances and every running tile gets the parts. */
const EVOLUTION_MS = 60_000;
/** Migrations of gridworld_evolution.json ({ planets, timeFactor }). Append; never edit one. */
const EVOLUTION_MIGRATIONS: Migration[] = [];

type Controller = ControllerPluginContext["controller"];

/** The reconciler's view of Clusterio (§6.2 facts, §5.2 instance settings). */
function clusterioPort(controller: Controller, balancerApi?: () => BalancerApi, balancerError?: string): Port {
	const to = (instanceId: number) => ({ instanceId });
	return {
		instances: () => {
			// §6.2: a start naming no save loads the host's newest file save other than *.tmp.zip.
			const saved = new Set<number>();
			for (const s of controller.saves.values()) {
				if (!s.isDeleted && s.type === "file" && !s.name.endsWith(".tmp.zip")) {
					saved.add(s.instanceId);
				}
			}
			return [...controller.instances.values()].map(i => ({
				id: i.id,
				name: i.config.get("instance.name"),
				status: i.status,
				host: i.config.get("instance.assigned_host"),
				hasSave: saved.has(i.id),
				gamePort: i.gamePort,
			}));
		},
		hosts: () => [...controller.hosts.values()].map(h => ({
			id: h.id, connected: h.connected, publicAddress: h.publicAddress,
		})),
		createInstance: async (name: string, config: TileConfig) => {
			// §5.2: the name and the tile config only; auto_start and exclude_from_start_all stay the operator's.
			const instanceConfig = new lib.InstanceConfig("controller");
			instanceConfig.set("instance.name", name);
			instanceConfig.set("gridworld.tile", config);
			return (await controller.instances.createInstance(instanceConfig)).id;
		},
		assign: (instanceId, host) => controller.instances.assignInstance(instanceId, host),
		createSave: async (instanceId, save, world) => {
			const { seed, mapGenSettings, mapSettings } = world;
			const request = new lib.InstanceCreateSaveRequest(save, seed, mapGenSettings, mapSettings);
			await controller.sendTo(to(instanceId), request);
		},
		start: async instanceId => {
			await controller.sendTo(to(instanceId), new lib.InstanceStartRequest());
		},
		stop: async instanceId => {
			await controller.sendTo(to(instanceId), new lib.InstanceStopRequest());
		},
		remove: instanceId => controller.instances.deleteInstance(instanceId),
		saveData: () => controller.saveData(),
		send: (instanceId, event) => {
			controller.sendTo(to(instanceId), event);
		},
		toggles: () => ({
			pollution_border: controller.config.get("gridworld.pollution_border"),
			cross_border_raids: controller.config.get("gridworld.cross_border_raids"),
			cross_border_expansion: controller.config.get("gridworld.cross_border_expansion"),
			shared_evolution: controller.config.get("gridworld.shared_evolution"),
		}),
		balancerApi: () => {
			if (!balancerApi) {
				const detail = balancerError ? ` (${balancerError})` : "";
				throw new Error(`balancer: not in the plugin list, or its dist/node/api.js won't import${detail}`);
			}
			return balancerApi();
		},
	};
}

export default async function loadControllerPlugin(context: ControllerPluginContext) {
	const { controller, logger, plugin } = context;
	const file = path.resolve(controller.config.get("controller.database_directory"), "gridworld_world.json");
	const store = new WorldStore(fileData(await loadDataFile(file, WORLD_MIGRATIONS)), {
		save: data => saveDataFile(file, WORLD_MIGRATIONS, data),
		published: layout => {
			controller.subscriptions.broadcast(new WorldLayoutEvent(layout.world, layout.tiles));
		},
	}, logger);
	let balancerError: string | undefined;
	const balancerApi = await loadBalancerApi(controller.pluginInfos, err => {
		balancerError = err instanceof Error ? err.message : String(err);
	});
	const reconciler = new Reconciler(store, clusterioPort(controller, balancerApi, balancerError), logger);
	// Player-crossing spec §7.2: a corner zone's key leads to the diagonal tile.
	registerCrossingResolver("gridworld", (from, key) => reconciler.crossing(from, key));

	const { hooks } = controller;
	hooks.instanceStatusChanged.attach(plugin.name, async instance => {
		await reconciler.onStatus(instance);
	});
	hooks.playerEvent.attach(plugin.name, async (instance, event) => {
		if (event.type === "join") {
			await reconciler.onPlayerJoin(instance.id);
		}
	});
	hooks.hostConnectionEvent.attach(plugin.name, async () => {
		reconciler.trigger();
	});
	hooks.controllerConfigFieldChanged.attach(plugin.name, async (field: string) => {
		reconciler.onControllerConfig(field);
	});
	controller.saves.on("update", () => reconciler.trigger());

	controller.handle(WorldCreateRequest, async (request: WorldCreateRequest) => {
		await reconciler.createWorld(request);
		// the evolution is keyed by surface name only, so a new world must not inherit the old world's parts
		Object.assign(evolution, newEvolution());
		saveDataFile(evolutionFile, EVOLUTION_MIGRATIONS, evolution).catch((err: Error) => {
			logger.error(`gw.evolution saving ${evolutionFile} failed: ${err.message}`);
		});
		return { layout: store.layout() };
	});
	controller.handle(WorldDeleteRequest, async () => {
		await reconciler.deleteWorld();
	});
	controller.handle(WorldGetRequest, async () => {
		const world = store.world;
		const anchor = world
			? { epochMs: world.epochMs, epochDaytime: world.epochDaytime, ticksPerDay: world.ticksPerDay }
			: undefined;
		return { layout: world ? store.layout() : null, tiles: reconciler.statuses(), anchor };
	});
	controller.handle(TileCreateRequest, async (request: TileCreateRequest) => {
		await reconciler.createTile(request.x, request.y);
	});
	controller.handle(TilePlanetsEvent, async (event: TilePlanetsEvent, src: lib.Address) => {
		await reconciler.onPlanets(src.id, event.planets);
	});
	// Cross-border biters spec §8: one set of evolution parts per planet for the cluster.
	const evolutionFile = path.resolve(
		controller.config.get("controller.database_directory"), "gridworld_evolution.json",
	);
	const evolution = (await loadDataFile(evolutionFile, EVOLUTION_MIGRATIONS) as Evolution | undefined)
		?? newEvolution();
	controller.handle(EvolutionReportEvent, async (event: EvolutionReportEvent) => {
		addReport(evolution, event.planets, event.timeFactor);
	});
	const evolutionTimer = setInterval(() => {
		const running = [...controller.instances.values()]
			.filter(i => i.status === "running" && i.config.get("gridworld.tile"));
		if (running.length === 0 || Object.keys(evolution.planets).length === 0) {
			return;
		}
		advance(evolution, EVOLUTION_MS / 1000);
		// The shared_evolution toggle: off, no tile is set (each runs as vanilla); the time part still advances.
		if (controller.config.get("gridworld.shared_evolution")) {
			const event = new EvolutionApplyEvent(parts(evolution));
			for (const i of running) {
				controller.sendTo({ instanceId: i.id }, event);
			}
		}
		saveDataFile(evolutionFile, EVOLUTION_MIGRATIONS, evolution).catch((err: Error) => {
			logger.error(`gw.evolution saving ${evolutionFile} failed: ${err.message}`);
		});
	}, EVOLUTION_MS);
	// §13: a subscriber gets the tiles changed since its last request; a new one passes 0 and gets them all.
	controller.subscriptions.handle(WorldLayoutEvent, async (request: lib.SubscriptionRequest) => {
		if (request.action === "unsubscribe") {
			return null;
		}
		const layout = store.layout(request.lastRequestTimeMs);
		return new WorldLayoutEvent(layout.world, layout.tiles);
	});

	const timer = setInterval(() => reconciler.trigger(), PASS_MS);
	const hourly = setInterval(() => reconciler.broadcastAnchors(), ANCHOR_MS);
	hooks.shutdown.attach(plugin.name, async () => {
		clearInterval(timer);
		clearInterval(hourly);
		clearInterval(evolutionTimer);
	});
	reconciler.trigger();
}
