import fs from "fs/promises";
import path from "path";

import * as lib from "@clusterio/lib";
import { BaseControllerPlugin, type InstanceInfo } from "@clusterio/controller";
import * as messages from "./messages";

type TileRecord = {
	x: number;
	y: number;
	instanceId: number;
	saveName: string;
	createdAtMs: number;
};

type ParsedMapSettings = {
	mapGenSettings: Record<string, any>;
	mapSettings: Record<string, any>;
	seed?: number;
};

type EdgeTargetSpec = {
	instanceId: number;
	origin: [number, number];
	surface: string;
	direction: number;
	ready: boolean;
};

type UniversalEdgesController = {
	edgeDatastore?: Map<string, any>;
	handleSetEdgeConfigRequest?: (request: { edge: any }) => Promise<void> | void;
};

// Universal edges uses 16-direction values where 0=east, 4=south, 8=west, 12=north.
const EDGE_DIRECTIONS = {
	north: 0,
	east: 4,
	south: 8,
	west: 12,
} as const;

const NEIGHBOR_DELTAS = [
	{ dx: 0, dy: -1 },
	{ dx: 1, dy: 0 },
	{ dx: 0, dy: 1 },
	{ dx: -1, dy: 0 },
];

const ACTIVE_INSTANCE_STATUSES = new Set<lib.InstanceStatus>([
	"starting",
	"running",
	"stopping",
	"creating_save",
	"exporting_data",
]);

function tileKey(x: number, y: number) {
	return `${x},${y}`;
}

function edgeKey(a: TileRecord, b: TileRecord) {
	const aKey = tileKey(a.x, a.y);
	const bKey = tileKey(b.x, b.y);
	return aKey < bKey ? `gridworld:${aKey}:${bKey}` : `gridworld:${bKey}:${aKey}`;
}

function deepClone<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

async function loadTiles(
	config: lib.ControllerConfig,
	logger: lib.Logger,
): Promise<Map<string, TileRecord>> {
	const filePath = path.resolve(config.get("controller.database_directory"), "gridworld_tiles.json");
	logger.verbose(`Loading ${filePath}`);
	try {
		const content = await fs.readFile(filePath, "utf8");
		if (!content.trim()) {
			return new Map();
		}
		const parsed = JSON.parse(content) as TileRecord[];

		const map = new Map<string, TileRecord>();
		const saveNamePrefix = config.get("gridworld.save_name_prefix");
		for (const entry of parsed) {
			if (!entry || typeof entry !== "object") {
				continue;
			}
			const e = entry as any;
			if (!Number.isFinite(e.x) || !Number.isFinite(e.y) || !Number.isFinite(e.instanceId)) {
				continue;
			}
			const x = e.x as number;
			const y = e.y as number;
			const instanceId = e.instanceId as number;
			const saveName = typeof e.saveName === "string"
				? e.saveName
				: `${saveNamePrefix}_${x}_${y}.zip`;
			const createdAtMs = Number.isFinite(e.createdAtMs)
				? e.createdAtMs as number
				: Date.now();
			map.set(tileKey(x, y), {
				x,
				y,
				instanceId,
				saveName,
				createdAtMs,
			});
		}
		return map;
	} catch (err: any) {
		if (err.code === "ENOENT") {
			logger.verbose("Creating new gridworld tile database");
			return new Map();
		}
		throw err;
	}
}

async function saveTiles(
	config: lib.ControllerConfig,
	tiles: Map<string, TileRecord>,
	logger: lib.Logger,
) {
	const filePath = path.resolve(config.get("controller.database_directory"), "gridworld_tiles.json");
	logger.verbose(`writing ${filePath}`);
	await lib.safeOutputFile(filePath, JSON.stringify([...tiles.values()], null, "\t"));
}

export class ControllerPlugin extends BaseControllerPlugin {
	private tiles = new Map<string, TileRecord>();
	private tilesByInstance = new Map<number, TileRecord>();
	private pendingTiles = new Map<string, Promise<TileRecord>>();
	private pendingStarts = new Map<number, Promise<void>>();
	private hostAssignIndex = 0;
	private storageDirty = false;
	private parsedMapSettings: ParsedMapSettings | null = null;
	private mapExchangeError: string | null = null;
	private stateUpdatedAtMs = Date.now();
	private stateBroadcastQueued = false;

	async init() {
		this.controller.handle(messages.GridworldStateRequest, this.handleGridworldStateRequest.bind(this));
		this.controller.handle(messages.GridworldCreateRequest, this.handleGridworldCreateRequest.bind(this));
		this.controller.handle(messages.GridworldDeleteRequest, this.handleGridworldDeleteRequest.bind(this));
		this.controller.subscriptions.handle(messages.GridworldStateUpdate, this.handleGridworldStateSubscription.bind(this));

		this.tiles = await loadTiles(this.controller.config, this.logger);
		this.rebuildTileIndex();
		this.loadMapExchangeString();
		await this.syncTileInstanceConfigs();
		await this.ensureEdgesForKnownTiles();
	}

	async onSaveData() {
		if (this.storageDirty) {
			await saveTiles(this.controller.config, this.tiles, this.logger);
			this.storageDirty = false;
		}
	}

	async onPlayerEvent(instance: InstanceInfo, event: lib.PlayerEvent) {
		if (event.type !== "join") {
			return;
		}
		const tile = this.tilesByInstance.get(instance.id);
		if (!tile) {
			return;
		}
		try {
			await this.ensureNeighbors(tile);
			await this.configureSpawnPosition(tile);
		} catch (err: any) {
			this.logger.warn(
				`Failed handling player join for tile ${tile.x},${tile.y}: ${err?.message ?? err}`,
			);
		}
	}

	async onControllerConfigFieldChanged(field: string) {
		if (field === "gridworld.map_exchange_string") {
			this.loadMapExchangeString();
			this.markStateDirty();
		}
		if (field === "gridworld.tile_size" || field === "gridworld.surface_name") {
			await this.syncTileInstanceConfigs();
			await this.ensureEdgesForKnownTiles();
			await this.configureSpawnPositionsForKnownTiles();
			if (field === "gridworld.tile_size") {
				this.markStateDirty();
			}
		}
		if (field === "gridworld.initial_tile_x" || field === "gridworld.initial_tile_y") {
			this.markStateDirty();
		}
	}

	private rebuildTileIndex() {
		this.tilesByInstance.clear();
		for (const [key, tile] of [...this.tiles.entries()]) {
			if (!this.controller.instances.has(tile.instanceId)) {
				this.logger.warn(`Dropping tile ${key} for missing instance ${tile.instanceId}`);
				this.tiles.delete(key);
				this.storageDirty = true;
				continue;
			}
			this.tilesByInstance.set(tile.instanceId, tile);
		}
	}

	private async syncTileInstanceConfigs() {
		const tileSize = this.controller.config.get("gridworld.tile_size");
		const surfaceName = this.controller.config.get("gridworld.surface_name");
		for (const tile of this.tiles.values()) {
			const instance = this.controller.instances.get(tile.instanceId);
			if (!instance) {
				continue;
			}
			let updated = false;
			if (instance.config.get("gridworld.tile_x") !== tile.x) {
				instance.config.set("gridworld.tile_x", tile.x, "controller");
				updated = true;
			}
			if (instance.config.get("gridworld.tile_y") !== tile.y) {
				instance.config.set("gridworld.tile_y", tile.y, "controller");
				updated = true;
			}
			if (instance.config.get("gridworld.tile_size") !== tileSize) {
				instance.config.set("gridworld.tile_size", tileSize, "controller");
				updated = true;
			}
			if (instance.config.get("gridworld.surface_name") !== surfaceName) {
				instance.config.set("gridworld.surface_name", surfaceName, "controller");
				updated = true;
			}
			if (updated) {
				try {
					await this.controller.instanceConfigUpdated(instance);
				} catch (err: any) {
					this.logger.warn(
						`Failed updating config for tile ${tile.x},${tile.y}: ${err?.message ?? err}`,
					);
				}
			}
		}
	}

	private setInstanceConfigForTile(instanceConfig: lib.InstanceConfig, x: number, y: number) {
		instanceConfig.set("gridworld.tile_x", x, "controller");
		instanceConfig.set("gridworld.tile_y", y, "controller");
		instanceConfig.set("gridworld.tile_size", this.controller.config.get("gridworld.tile_size"), "controller");
		instanceConfig.set("gridworld.surface_name", this.controller.config.get("gridworld.surface_name"), "controller");
	}

	private loadMapExchangeString() {
		const exchangeString = this.controller.config.get("gridworld.map_exchange_string");
		if (!exchangeString || !exchangeString.trim()) {
			this.parsedMapSettings = null;
			this.mapExchangeError = "Map exchange string is not configured.";
			return;
		}
		try {
			const parsed = lib.readMapExchangeString(exchangeString);
			this.parsedMapSettings = {
				mapGenSettings: parsed.map_gen_settings,
				mapSettings: parsed.map_settings,
				seed: parsed.map_gen_settings.seed,
			};
			this.mapExchangeError = null;
		} catch (err: any) {
			this.parsedMapSettings = null;
			this.mapExchangeError = err.message ?? String(err);
			this.logger.error(`Failed to parse map exchange string: ${this.mapExchangeError}`);
		}
	}

	private getUniversalEdgesController(): UniversalEdgesController | null {
		const plugin = this.controller.plugins.get("universal_edges") as UniversalEdgesController | undefined;
		if (!plugin) {
			this.logger.warn("Universal edges plugin not loaded; gridworld edges will not be created.");
			return null;
		}
		return plugin;
	}

	private async ensureTile(x: number, y: number, reason: string): Promise<TileRecord> {
		const key = tileKey(x, y);
		const existing = this.tiles.get(key);
		if (existing) {
			return existing;
		}
		const pending = this.pendingTiles.get(key);
		if (pending) {
			return await pending;
		}
		const creation = this.createTile(x, y, reason).finally(() => {
			this.pendingTiles.delete(key);
		});
		this.pendingTiles.set(key, creation);
		return await creation;
	}

	private async createTile(x: number, y: number, reason: string): Promise<TileRecord> {
		const mapSettings = this.buildMapSettingsForTile(x, y);
		if (!mapSettings) {
			throw new lib.ResponseError(
				`Cannot create tile ${x},${y}: ${this.mapExchangeError ?? "map exchange string is not configured."}`,
			);
		}
		const hostId = this.getHostIdForTile();
		if (hostId === undefined) {
			throw new lib.ResponseError(`Cannot create tile ${x},${y}: no hosts connected.`);
		}

		const instanceName = `gridworld_${x}_${y}`;
		const saveName = `${this.controller.config.get("gridworld.save_name_prefix")}_${x}_${y}.zip`;
		const instanceConfig = new lib.InstanceConfig("controller");
		instanceConfig.set("instance.name", instanceName, "controller");
		instanceConfig.set("instance.auto_start", false, "controller");
		this.setInstanceConfigForTile(instanceConfig, x, y);

		await this.controller.instanceCreate(instanceConfig);
		const instanceId = instanceConfig.get("instance.id");
		const tile: TileRecord = {
			x,
			y,
			instanceId,
			saveName,
			createdAtMs: Date.now(),
		};

		try {
			const assigned = await this.assignAndSetupInstance(tile, hostId);
			if (!assigned) {
				throw new lib.ResponseError(
					`Failed assigning instance ${instanceId} for tile ${x},${y}`,
				);
			}

			await this.ensureInstanceStarted(tile, reason, mapSettings);
			await this.ensureEdgesForTile(tile);
		} catch (err: any) {
			this.logger.error(
				`Tile creation failed for ${x},${y} (instance ${instanceId}): ${err?.message ?? err}`,
			);
			await this.cleanupFailedTileCreation(tile);
			throw err;
		}

		this.tiles.set(tileKey(x, y), tile);
		this.tilesByInstance.set(instanceId, tile);
		this.storageDirty = true;
		this.markStateDirty();
		this.logger.info(`Created tile ${x},${y} for instance ${instanceId} (${reason})`);
		return tile;
	}

	private getHostIdForTile(): number | undefined {
		const hostIds = [...this.controller.wsServer.hostConnections.keys()];
		if (!hostIds.length) {
			this.logger.warn("No hosts connected; cannot assign new gridworld instances.");
			return undefined;
		}
		hostIds.sort((a, b) => a - b);
		const hostId = hostIds[this.hostAssignIndex % hostIds.length];
		this.hostAssignIndex = (this.hostAssignIndex + 1) % hostIds.length;
		return hostId;
	}

	private async assignAndSetupInstance(tile: TileRecord, hostId?: number): Promise<boolean> {
		const resolvedHostId = hostId ?? this.getHostIdForTile();
		if (resolvedHostId === undefined) {
			return false;
		}
		try {
			await this.controller.instanceAssign(tile.instanceId, resolvedHostId);
			return true;
		} catch (err: any) {
			this.logger.error(`Failed to assign instance ${tile.instanceId}: ${err?.message ?? err}`);
			return false;
		}
	}

	private buildMapSettingsForTile(x: number, y: number): ParsedMapSettings | null {
		if (!this.parsedMapSettings) {
			return null;
		}
		const mapGenSettings = deepClone(this.parsedMapSettings.mapGenSettings);
		const mapSettings = deepClone(this.parsedMapSettings.mapSettings);
		const initialX = this.controller.config.get("gridworld.initial_tile_x");
		const initialY = this.controller.config.get("gridworld.initial_tile_y");
		const tileSize = this.controller.config.get("gridworld.tile_size");
		const offsetX = initialX * tileSize;
		const offsetY = initialY * tileSize;
		if (mapGenSettings.area_to_generate_at_start) {
			const area = mapGenSettings.area_to_generate_at_start;
			if (area.left_top) {
				area.left_top.x += offsetX;
				area.left_top.y += offsetY;
			}
			if (area.right_bottom) {
				area.right_bottom.x += offsetX;
				area.right_bottom.y += offsetY;
			}
		}
		if (Array.isArray(mapGenSettings.starting_points)) {
			mapGenSettings.starting_points = mapGenSettings.starting_points.map((point: { x: number; y: number }) => ({
				x: point.x + offsetX,
				y: point.y + offsetY,
			}));
		} else {
			mapGenSettings.starting_points = [{ x: offsetX, y: offsetY }];
		}

		const seed = typeof mapGenSettings.seed === "number"
			? mapGenSettings.seed
			: this.parsedMapSettings.seed;

		return {
			mapGenSettings,
			mapSettings,
			seed,
		};
	}

	private async ensureNeighbors(tile: TileRecord) {
		for (const delta of NEIGHBOR_DELTAS) {
			const neighbor = await this.ensureTile(tile.x + delta.dx, tile.y + delta.dy, "neighbor");
			await this.ensureInstanceStarted(neighbor, "neighbor");
			await this.ensureEdgeBetween(tile, neighbor);
		}
	}

	private async ensureEdgesForKnownTiles() {
		for (const tile of this.tiles.values()) {
			await this.ensureEdgesForTile(tile);
		}
	}

	private async ensureEdgesForTile(tile: TileRecord) {
		for (const delta of NEIGHBOR_DELTAS) {
			const neighbor = this.tiles.get(tileKey(tile.x + delta.dx, tile.y + delta.dy));
			if (neighbor) {
				await this.ensureEdgeBetween(tile, neighbor);
			}
		}
	}

	private async ensureEdgeBetween(tile: TileRecord, neighbor: TileRecord) {
		const ue = this.getUniversalEdgesController();
		if (!ue?.handleSetEdgeConfigRequest) {
			return;
		}
		const edgeId = edgeKey(tile, neighbor);
		const existingEdge = ue.edgeDatastore?.get(edgeId);

		const [sourceTile, targetTile] = this.orderTiles(tile, neighbor);
		const sourceSpec = this.buildEdgeTargetSpec(sourceTile, targetTile);
		const targetSpec = this.buildEdgeTargetSpec(targetTile, sourceTile);
		const tileSize = this.controller.config.get("gridworld.tile_size");

		const desiredEdge = {
			id: edgeId,
			updatedAtMs: Date.now(),
			isDeleted: false,
			source: sourceSpec,
			target: targetSpec,
			length: tileSize,
			link_destinations: existingEdge?.link_destinations ?? {},
		};

		if (existingEdge && !existingEdge.isDeleted) {
			if (!this.edgeConfigNeedsUpdate(existingEdge, desiredEdge)) {
				return;
			}
			await ue.handleSetEdgeConfigRequest({
				edge: {
					...existingEdge,
					...desiredEdge,
				},
			});
			return;
		}

		await ue.handleSetEdgeConfigRequest({
			edge: {
				...existingEdge,
				...desiredEdge,
				active: existingEdge?.active ?? true,
			},
		});
	}

	private edgeTargetSpecEquals(a: any, b: any) {
		if (!a || !b) {
			return false;
		}
		if (a.instanceId !== b.instanceId) {
			return false;
		}
		if (a.surface !== b.surface) {
			return false;
		}
		if (a.direction !== b.direction) {
			return false;
		}
		if (Boolean(a.ready) !== Boolean(b.ready)) {
			return false;
		}
		const aOrigin = Array.isArray(a.origin) ? a.origin : null;
		const bOrigin = Array.isArray(b.origin) ? b.origin : null;
		if (!aOrigin || !bOrigin || aOrigin.length < 2 || bOrigin.length < 2) {
			return false;
		}
		return aOrigin[0] === bOrigin[0] && aOrigin[1] === bOrigin[1];
	}

	private edgeConfigNeedsUpdate(existingEdge: any, desiredEdge: any) {
		if (!existingEdge || !desiredEdge) {
			return true;
		}
		if (existingEdge.length !== desiredEdge.length) {
			return true;
		}
		if (!this.edgeTargetSpecEquals(existingEdge.source, desiredEdge.source)) {
			return true;
		}
		if (!this.edgeTargetSpecEquals(existingEdge.target, desiredEdge.target)) {
			return true;
		}
		return false;
	}

	private orderTiles(a: TileRecord, b: TileRecord): [TileRecord, TileRecord] {
		if (a.x !== b.x) {
			return a.x < b.x ? [a, b] : [b, a];
		}
		if (a.y !== b.y) {
			return a.y < b.y ? [a, b] : [b, a];
		}
		return [a, b];
	}

	private buildEdgeTargetSpec(tile: TileRecord, neighbor: TileRecord): EdgeTargetSpec {
		const bounds = this.tileBounds(tile.x, tile.y);
		const surface = this.controller.config.get("gridworld.surface_name");
		const side = this.getSide(tile, neighbor);
		const { origin, direction } = this.edgeSideSpec(bounds, side);
		return {
			instanceId: tile.instanceId,
			origin: [origin[0], origin[1]],
			surface,
			direction,
			ready: true,
		};
	}

	private getSide(tile: TileRecord, neighbor: TileRecord): "north" | "east" | "south" | "west" {
		if (neighbor.x === tile.x && neighbor.y === tile.y - 1) {
			return "north";
		}
		if (neighbor.x === tile.x && neighbor.y === tile.y + 1) {
			return "south";
		}
		if (neighbor.x === tile.x + 1 && neighbor.y === tile.y) {
			return "east";
		}
		return "west";
	}

	private tileBounds(x: number, y: number) {
		const tileSize = this.controller.config.get("gridworld.tile_size");
		const half = tileSize / 2;
		const centerX = x * tileSize;
		const centerY = y * tileSize;
		return {
			minX: centerX - half,
			maxX: centerX + half,
			minY: centerY - half,
			maxY: centerY + half,
		};
	}

	private edgeSideSpec(bounds: { minX: number; maxX: number; minY: number; maxY: number }, side: "north" | "east" | "south" | "west") {
		switch (side) {
			case "north":
				return {
					origin: [bounds.minX, bounds.minY] as [number, number],
					direction: EDGE_DIRECTIONS.north,
				};
			case "south":
				return {
					origin: [bounds.maxX, bounds.maxY] as [number, number],
					direction: EDGE_DIRECTIONS.south,
				};
			case "east":
				return {
					origin: [bounds.maxX, bounds.minY] as [number, number],
					direction: EDGE_DIRECTIONS.east,
				};
			case "west":
			default:
				return {
					origin: [bounds.minX, bounds.maxY] as [number, number],
					direction: EDGE_DIRECTIONS.west,
				};
		}
	}

	private async ensureInstanceStarted(tile: TileRecord, reason: string, mapSettings?: ParsedMapSettings) {
		const pending = this.pendingStarts.get(tile.instanceId);
		if (pending) {
			await pending;
			return;
		}

		const startPromise = this.startInstanceIfNeeded(tile, reason, mapSettings).finally(() => {
			this.pendingStarts.delete(tile.instanceId);
		});
		this.pendingStarts.set(tile.instanceId, startPromise);
		await startPromise;
	}

	private async startInstanceIfNeeded(tile: TileRecord, reason: string, mapSettingsOverride?: ParsedMapSettings) {
		const instance = this.controller.instances.get(tile.instanceId);
		if (!instance) {
			this.logger.warn(`Missing instance ${tile.instanceId} for tile ${tile.x},${tile.y}`);
			return;
		}

		if (instance.status === "running" || instance.status === "starting" || instance.status === "creating_save") {
			return;
		}

		if (instance.config.get("instance.assigned_host") === null) {
			const assigned = await this.assignAndSetupInstance(tile);
			const updated = this.controller.instances.get(tile.instanceId);
			if (!assigned || updated?.config.get("instance.assigned_host") === null) {
				this.logger.warn(
					`Cannot start tile ${tile.x},${tile.y}: instance ${tile.instanceId} is not assigned to a host.`,
				);
				return;
			}
		}

		const mapSettings = mapSettingsOverride ?? this.buildMapSettingsForTile(tile.x, tile.y);
		if (!mapSettings) {
			this.logger.error(`Skipping save creation for tile ${tile.x},${tile.y}: ${this.mapExchangeError}`);
			return;
		}

		const hasSave = [...this.controller.saves.values()].some(save =>
			save.instanceId === tile.instanceId && save.name === tile.saveName && !save.isDeleted
		);

		if (!hasSave) {
			try {
				await this.controller.sendTo(
					{ instanceId: tile.instanceId },
					new lib.InstanceCreateSaveRequest(
						tile.saveName,
						mapSettings.seed,
						mapSettings.mapGenSettings,
						mapSettings.mapSettings,
					),
				);
			} catch (err: any) {
				this.logger.error(
					`Failed creating save for tile ${tile.x},${tile.y}: ${err?.message ?? err}`,
				);
				return;
			}
		}

		try {
			await this.controller.sendTo(
				{ instanceId: tile.instanceId },
				new lib.InstanceStartRequest(tile.saveName),
			);
			this.logger.info(`Started tile ${tile.x},${tile.y} (${reason})`);
		} catch (err: any) {
			this.logger.error(
				`Failed starting instance ${tile.instanceId} for tile ${tile.x},${tile.y}: ${err?.message ?? err}`,
			);
			return;
		}

		try {
			await this.configureFreeplayIntro(tile);
		} catch (err: any) {
			this.logger.warn(
				`Failed configuring freeplay intro for tile ${tile.x},${tile.y}: ${err?.message ?? err}`,
			);
		}

		try {
			await this.configureSpawnPosition(tile);
		} catch (err: any) {
			this.logger.warn(
				`Failed configuring spawn for tile ${tile.x},${tile.y}: ${err?.message ?? err}`,
			);
		}
	}

	private async cleanupFailedTileCreation(tile: TileRecord) {
		try {
			const edgeCleanupTiles: TileRecord[] = [tile];
			for (const delta of NEIGHBOR_DELTAS) {
				const neighbor = this.tiles.get(tileKey(tile.x + delta.dx, tile.y + delta.dy));
				if (neighbor) {
					edgeCleanupTiles.push(neighbor);
				}
			}
			await this.removeEdgesForTiles(edgeCleanupTiles);
		} catch (err: any) {
			this.logger.warn(
				`Failed removing edges for aborted tile ${tile.x},${tile.y}: ${err?.message ?? err}`,
			);
		}

		await this.stopInstanceBeforeDelete(tile.instanceId, `aborted tile ${tile.x},${tile.y}`);
		try {
			await this.controller.instanceDelete(tile.instanceId);
		} catch (err: any) {
			this.logger.error(
				`Failed deleting aborted tile instance ${tile.instanceId} (${tile.x},${tile.y}): ${err?.message ?? err}`,
			);
		}
	}


	private async configureFreeplayIntro(tile: TileRecord) {
		const commands = [
			`/c remote.call("freeplay", "set_disable_crashsite", true)`,
			`/c remote.call("freeplay", "set_skip_intro", true)`,
		];

		for (const command of commands) {
			await this.controller.sendTo(
				{ instanceId: tile.instanceId },
				new lib.InstanceSendRconRequest(command),
			);
		}
	}

	private async configureSpawnPosition(tile: TileRecord) {
		const tileSize = this.controller.config.get("gridworld.tile_size");
		const surface = this.controller.config.get("gridworld.surface_name");
		const escapedSurface = lib.escapeString(surface);
		const x = tile.x * tileSize;
		const y = tile.y * tileSize;
		const command = `/c local force=game.forces.player; local surface=game.surfaces["${escapedSurface}"]; if force and surface then force.set_spawn_position({x=${x}, y=${y}}, surface) end`;
		await this.controller.sendTo(
			{ instanceId: tile.instanceId },
			new lib.InstanceSendRconRequest(command),
		);
	}

	private async configureSpawnPositionsForKnownTiles() {
		for (const tile of this.tiles.values()) {
			const instance = this.controller.instances.get(tile.instanceId);
			if (!instance || instance.status !== "running") {
				continue;
			}
			try {
				await this.configureSpawnPosition(tile);
			} catch (err: any) {
				this.logger.warn(
					`Failed configuring spawn for tile ${tile.x},${tile.y}: ${err?.message ?? err}`,
				);
			}
		}
	}

	private async stopInstanceBeforeDelete(instanceId: number, context?: string) {
		const instance = this.controller.instances.get(instanceId);
		if (!instance) {
			return;
		}

		if (!ACTIVE_INSTANCE_STATUSES.has(instance.status)) {
			return;
		}

		try {
			await this.controller.sendTo(
				{ instanceId },
				new lib.InstanceStopRequest(),
			);
		} catch (err: any) {
			const contextSuffix = context ? ` (${context})` : "";
			this.logger.error(
				`Failed stopping instance ${instanceId}${contextSuffix}: ${err?.message ?? err}`,
			);
			return;
		}

		const deadline = Date.now() + 5000;
		while (Date.now() < deadline) {
			const updated = this.controller.instances.get(instanceId);
			if (!updated || !ACTIVE_INSTANCE_STATUSES.has(updated.status)) {
				break;
			}
			/* eslint-disable-next-line no-await-in-loop */
			await new Promise(resolve => setTimeout(resolve, 250));
		}
	}

	private getStateValue(): messages.GridworldStateValue {
		return {
			id: "state",
			updatedAtMs: this.stateUpdatedAtMs,
			isDeleted: false,
			...this.getState(),
		};
	}

	private markStateDirty() {
		const now = Date.now();
		this.stateUpdatedAtMs = now > this.stateUpdatedAtMs ? now : this.stateUpdatedAtMs + 1;
		if (this.stateBroadcastQueued) {
			return;
		}
		this.stateBroadcastQueued = true;
		setImmediate(() => {
			this.stateBroadcastQueued = false;
			this.controller.subscriptions.broadcast(new messages.GridworldStateUpdate([
				this.getStateValue(),
			]));
		});
	}

	private async handleGridworldStateSubscription(request: lib.SubscriptionRequest) {
		if (this.stateUpdatedAtMs <= request.lastRequestTimeMs) {
			return null;
		}
		return new messages.GridworldStateUpdate([
			this.getStateValue(),
		]);
	}

	private getState(): messages.GridworldStateResponse {
		const tiles = [...this.tiles.values()].map(tile => ({
			x: tile.x,
			y: tile.y,
			instanceId: tile.instanceId,
			saveName: tile.saveName,
			createdAtMs: tile.createdAtMs,
		}));
		tiles.sort((a, b) => (a.y - b.y) || (a.x - b.x));

		return {
			tiles,
			tileSize: this.controller.config.get("gridworld.tile_size"),
			initialTile: {
				x: this.controller.config.get("gridworld.initial_tile_x"),
				y: this.controller.config.get("gridworld.initial_tile_y"),
			},
			mapExchangeError: this.mapExchangeError,
		};
	}

	private async handleGridworldStateRequest(_request: messages.GridworldStateRequest) {
		return this.getState();
	}

	private async handleGridworldCreateRequest(_request: messages.GridworldCreateRequest) {
		await this.resetGridworld(true);
		return this.getState();
	}

	private async handleGridworldDeleteRequest(_request: messages.GridworldDeleteRequest) {
		await this.resetGridworld(false);
		return this.getState();
	}

	private async resetGridworld(createInitial: boolean) {
		if (this.pendingTiles.size) {
			await Promise.allSettled([...this.pendingTiles.values()]);
			this.pendingTiles.clear();
		}

		const tiles = [...this.tiles.values()];
		await this.removeEdgesForTiles(tiles);

		const deletedInstanceIds = new Set<number>();
		for (const tile of tiles) {
			await this.stopInstanceBeforeDelete(tile.instanceId, `gridworld tile ${tile.x},${tile.y}`);
			try {
				await this.controller.instanceDelete(tile.instanceId);
				deletedInstanceIds.add(tile.instanceId);
			} catch (err: any) {
				this.logger.error(
					`Failed deleting instance ${tile.instanceId} for tile ${tile.x},${tile.y}: ${err?.message ?? err}`,
				);
			}
		}

		const namePrefix = "gridworld_";
		for (const instance of this.controller.instances.values()) {
			if (deletedInstanceIds.has(instance.id)) {
				continue;
			}
			const name = instance.config.get("instance.name");
			if (!name.startsWith(namePrefix)) {
				continue;
			}
			await this.stopInstanceBeforeDelete(instance.id, name);
			try {
				await this.controller.instanceDelete(instance.id);
			} catch (err: any) {
				this.logger.error(
					`Failed deleting instance ${instance.id} (${name}): ${err?.message ?? err}`,
				);
			}
		}

		this.tiles.clear();
		this.tilesByInstance.clear();
		this.storageDirty = true;

		if (createInitial) {
			const x = this.controller.config.get("gridworld.initial_tile_x");
			const y = this.controller.config.get("gridworld.initial_tile_y");
			await this.ensureTile(x, y, "reset");
		}
		this.markStateDirty();
	}

	private async removeEdgesForTiles(tiles: TileRecord[]) {
		const ue = this.getUniversalEdgesController();
		if (!ue?.handleSetEdgeConfigRequest || !ue.edgeDatastore) {
			return;
		}

		const tileMap = new Map(tiles.map(tile => [tileKey(tile.x, tile.y), tile]));
		const edgeIds = new Set<string>();
		for (const tile of tiles) {
			for (const delta of NEIGHBOR_DELTAS) {
				const neighbor = tileMap.get(tileKey(tile.x + delta.dx, tile.y + delta.dy));
				if (neighbor) {
					edgeIds.add(edgeKey(tile, neighbor));
				}
			}
		}

		for (const edgeId of edgeIds) {
			const edge = ue.edgeDatastore.get(edgeId);
			if (!edge || edge.isDeleted) {
				continue;
			}
			await ue.handleSetEdgeConfigRequest({
				edge: {
					...edge,
					isDeleted: true,
					updatedAtMs: Date.now(),
				},
			});
		}
	}
}
