import fs from "fs/promises";
import path from "path";

import * as lib from "@clusterio/lib";
import { BaseControllerPlugin, type InstanceRecord } from "@clusterio/controller";
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
	storageDirty?: boolean;
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

const DAYTIME_SYNC_INTERVAL_MS = 600_000; // 600 seconds

type TimeEpoch = {
	epochMs: number;
	epochDaytime: number;
};

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

/** Rotate a 2D vector by a Factorio 16-direction value (0/4/8/12). */
function vec2Rot(a: [number, number], dir: number): [number, number] {
	if (dir === 0) return [a[0], a[1]];
	if (dir === 4) return [-a[1], a[0]];
	if (dir === 8) return [-a[0], -a[1]];
	if (dir === 12) return [a[1], -a[0]];
	throw new Error(`Invalid direction: ${dir}`);
}

/** Convert edge-local coordinates to world coordinates. */
function edgePosToWorld(edgePos: [number, number], origin: [number, number], direction: number): [number, number] {
	const rotated = vec2Rot(edgePos, direction);
	return [origin[0] + rotated[0], origin[1] + rotated[1]];
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
	private timeEpoch: TimeEpoch = { epochMs: Date.now(), epochDaytime: 0 };
	private timeEpochDirty = false;
	private timeSyncInterval: ReturnType<typeof setInterval> | null = null;
	private pendingTrainPathDestinations = new Map<string, string>();

	async init() {
		this.controller.handle(messages.GridworldStateRequest, this.handleGridworldStateRequest.bind(this));
		this.controller.handle(messages.GridworldCreateRequest, this.handleGridworldCreateRequest.bind(this));
		this.controller.handle(messages.GridworldDeleteRequest, this.handleGridworldDeleteRequest.bind(this));
		this.controller.handle(messages.GridworldSyncRailEntities, this.handleGridworldSyncRailEntities.bind(this));
		this.controller.handle(messages.GridworldSyncUeStops, this.handleGridworldSyncUeStops.bind(this));
		this.controller.handle(messages.GridworldRequestTrainPath, this.handleGridworldRequestTrainPath.bind(this));
		this.controller.handle(messages.GridworldReturnTrainPathResult, this.handleGridworldReturnTrainPathResult.bind(this));
		this.controller.handle(messages.GridworldClearTrainPath, this.handleGridworldClearTrainPath.bind(this));
		this.controller.handle(messages.GridworldRemoveTrainProxy, this.handleGridworldRemoveTrainProxy.bind(this));
		this.controller.handle(messages.GridworldCornerTeleportPlayer, this.handleCornerTeleportPlayer.bind(this));
		this.controller.subscriptions.handle(messages.GridworldStateUpdate, this.handleGridworldStateSubscription.bind(this));

		this.tiles = await loadTiles(this.controller.config, this.logger);
		this.rebuildTileIndex();
		this.loadMapExchangeString();
		await this.loadTimeEpoch();
		await this.syncTileInstanceConfigs();
		await this.ensureEdgesForKnownTiles();

		this.timeSyncInterval = setInterval(() => {
			this.broadcastDaytime(false).catch(err =>
				this.logger.error(`Failed broadcasting daytime: ${err?.message ?? err}`),
			);
		}, DAYTIME_SYNC_INTERVAL_MS);
	}

	async onShutdown() {
		if (this.timeSyncInterval !== null) {
			clearInterval(this.timeSyncInterval);
			this.timeSyncInterval = null;
		}
	}

	async onInstanceStatusChanged(instance: InstanceRecord, prev?: lib.InstanceStatus) {
		if (instance.status === "running" && prev !== "running") {
			if (instance.config.get("instance.name") === "pathworld") {
				return;
			}
			try {
				await this.sendDaytimeToInstance(instance.id, true);
			} catch (err: any) {
				this.logger.warn(
					`Failed sending startup daytime to instance ${instance.id}: ${err?.message ?? err}`,
				);
			}
			// Send corner neighbor info for diagonal entity transport
			const tile = this.tilesByInstance.get(instance.id);
			if (tile) {
				await this.sendCornerNeighbors(tile);
			}
		}
	}

	async onSaveData() {
		if (this.storageDirty) {
			await saveTiles(this.controller.config, this.tiles, this.logger);
			this.storageDirty = false;
		}
		if (this.timeEpochDirty) {
			await this.saveTimeEpoch();
			this.timeEpochDirty = false;
		}
	}

	async onPlayerEvent(instance: InstanceRecord, event: lib.PlayerEvent) {
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

		await this.controller.instances.createInstance(instanceConfig);
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
		await this.updateCornerNeighborsForNewTile(tile);
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
			await this.controller.instances.assignInstance(tile.instanceId, resolvedHostId);
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

	private computeCornerNeighbors(tile: TileRecord): { ne?: number; se?: number; sw?: number; nw?: number } {
		const ne = this.tiles.get(tileKey(tile.x + 1, tile.y - 1));
		const se = this.tiles.get(tileKey(tile.x + 1, tile.y + 1));
		const sw = this.tiles.get(tileKey(tile.x - 1, tile.y + 1));
		const nw = this.tiles.get(tileKey(tile.x - 1, tile.y - 1));
		return {
			ne: ne?.instanceId,
			se: se?.instanceId,
			sw: sw?.instanceId,
			nw: nw?.instanceId,
		};
	}

	private async sendCornerNeighbors(tile: TileRecord) {
		const neighbors = this.computeCornerNeighbors(tile);
		const instance = this.controller.instances.get(tile.instanceId);
		if (!instance || instance.status !== "running") {
			return;
		}
		try {
			await this.controller.sendTo({ instanceId: tile.instanceId }, new messages.GridworldCornerNeighbors(neighbors));
		} catch (err: any) {
			this.logger.warn(`Failed to send corner neighbors to tile ${tile.x},${tile.y}: ${err?.message ?? err}`);
		}
	}

	private async updateCornerNeighborsForNewTile(tile: TileRecord) {
		await this.sendCornerNeighbors(tile);
		const DIAGONAL_DELTAS = [
			{ dx: -1, dy: -1 }, { dx: 1, dy: -1 },
			{ dx: -1, dy: 1 }, { dx: 1, dy: 1 },
		];
		for (const delta of DIAGONAL_DELTAS) {
			const diag = this.tiles.get(tileKey(tile.x + delta.dx, tile.y + delta.dy));
			if (diag) {
				await this.sendCornerNeighbors(diag);
			}
		}
	}

	async handleCornerTeleportPlayer({ playerName, instanceId }: messages.GridworldCornerTeleportPlayer) {
		const instance = this.controller.instances.get(instanceId);
		if (!instance) {
			throw new lib.ResponseError(`Instance ${instanceId} not found for corner teleport`);
		}
		const hostId = instance.config.get("instance.assigned_host");
		if (!hostId) {
			throw new lib.ResponseError(`Instance ${instanceId} has no assigned host`);
		}
		const host = this.controller.hosts.get(hostId);
		if (!host) {
			throw new lib.ResponseError(`Host ${hostId} not found for instance ${instanceId}`);
		}
		if (!host.publicAddress) {
			throw new lib.ResponseError(`Host ${hostId} has no public address configured`);
		}
		const address = `${host.publicAddress}:${instance.gamePort || instance.config.get("factorio.game_port")}`;
		const name = instance.config.get("instance.name") as string;
		this.logger.info(`Corner teleporting ${playerName} to ${address} (instance ${instanceId})`);
		return { address, name };
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
		let instance = this.controller.instances.get(tile.instanceId);
		if (!instance) {
			this.logger.warn(`Instance ${tile.instanceId} missing for tile ${tile.x},${tile.y}, creating new instance`);
			const instanceName = `gridworld_${tile.x}_${tile.y}`;
			const instanceConfig = new lib.InstanceConfig("controller");
			instanceConfig.set("instance.name", instanceName, "controller");
			instanceConfig.set("instance.auto_start", false, "controller");
			this.setInstanceConfigForTile(instanceConfig, tile.x, tile.y);
			await this.controller.instances.createInstance(instanceConfig);
			const newInstanceId = instanceConfig.get("instance.id");
			this.tilesByInstance.delete(tile.instanceId);
			tile.instanceId = newInstanceId;
			this.tilesByInstance.set(newInstanceId, tile);
			this.storageDirty = true;
			instance = this.controller.instances.get(newInstanceId);
			if (!instance) {
				this.logger.error(`Failed to recreate instance for tile ${tile.x},${tile.y}`);
				return;
			}
			await this.ensureEdgesForTile(tile);
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

		try {
			await this.generateTileChunks(tile);
		} catch (err: any) {
			this.logger.warn(
				`Failed generating chunks for tile ${tile.x},${tile.y}: ${err?.message ?? err}`,
			);
		}

		await this.syncTileAreasToPathworld([tile]);
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
			await this.controller.instances.deleteInstance(tile.instanceId);
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
		const command = `/sc local force=game.forces.player; local surface=game.surfaces["${escapedSurface}"]; if force and surface then force.set_spawn_position({x=${x}, y=${y}}, surface) end`;
		await this.controller.sendTo(
			{ instanceId: tile.instanceId },
			new lib.InstanceSendRconRequest(command),
		);
	}

	private async generateTileChunks(tile: TileRecord) {
		const tileSize = this.controller.config.get("gridworld.tile_size");
		const surface = this.controller.config.get("gridworld.surface_name");
		const escapedSurface = lib.escapeString(surface);
		const half = tileSize / 2;
		const margin = 128; // 4 chunks
		const minX = tile.x * tileSize - half - margin;
		const maxX = tile.x * tileSize + half + margin;
		const minY = tile.y * tileSize - half - margin;
		const maxY = tile.y * tileSize + half + margin;
		const command = `/c local s=game.surfaces["${escapedSurface}"]; if not s then return end; local cs=32; for cx=math.floor(${minX}/cs),math.floor((${maxX}-1)/cs) do for cy=math.floor(${minY}/cs),math.floor((${maxY}-1)/cs) do s.request_to_generate_chunks({x=cx*cs,y=cy*cs},0) end end; s.force_generate_chunk_requests()`;
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

	private async handleGridworldSyncUeStops(event: messages.GridworldSyncUeStops) {
		const pathworldId = this.getPathworldInstanceId();
		if (pathworldId === undefined) {
			return;
		}
		const pathworldInstance = this.controller.instances.get(pathworldId);
		if (!pathworldInstance || pathworldInstance.status !== "running") {
			return;
		}

		// Recompute stop positions so they sit just inside the edge border
		// on the pathworld.  On the tile instance the stops live at
		// edge_pos {edge_x+2, -7}; on the pathworld we move them to
		// {edge_x+2, -1} — one unit into the edge area, adjacent to the
		// neighbor tile's first parking rail which IS synced.
		const stops = this.computePathworldUeStopPositions(event.tileX, event.tileY, event.stops);

		try {
			await this.controller.sendTo(
				{ instanceId: pathworldId },
				new messages.GridworldApplyUeStops(event.tileX, event.tileY, stops),
			);
		} catch (err: any) {
			this.logger.warn(`[gridworld] Failed to forward ue_stops to pathworld: ${err?.message ?? err}`);
		}
	}

	/**
	 * For each ue_source_trainstop, compute a position just inside the tile
	 * border using the edge definition.  Falls back to the original tile
	 * position when edge data is unavailable.
	 */
	private computePathworldUeStopPositions(
		tileX: number,
		tileY: number,
		stops: messages.UeStop[],
	): messages.UeStop[] {
		const ue = this.getUniversalEdgesController();
		if (!ue?.edgeDatastore) {
			return stops;
		}
		const tile = this.tiles.get(tileKey(tileX, tileY));
		if (!tile) {
			return stops;
		}

		return stops.map(stop => {
			if (!stop.stopName) {
				return stop;
			}
			const parts = stop.stopName.split(" ");
			if (parts.length < 2) {
				return stop;
			}
			const edgeId = parts[0];
			const offset = Number(parts[1]);
			if (!Number.isFinite(offset)) {
				return stop;
			}
			const edge = ue.edgeDatastore!.get(edgeId);
			if (!edge) {
				return stop;
			}

			// Determine which side of the edge this tile is on
			const side: EdgeTargetSpec = (edge.source.instanceId === tile.instanceId)
				? edge.source
				: edge.target;
			const edgeX = side.direction >= 8 ? edge.length - offset : offset;

			// Place the stop at edge_pos {edgeX + 2, -1}: one unit into the
			// edge area (just past the tile border), adjacent to the neighbor
			// tile's first synced parking rail at that offset.
			const [worldX, worldY] = edgePosToWorld([edgeX + 2, -1], side.origin as [number, number], side.direction);

			return {
				...stop,
				x: worldX,
				y: worldY,
			};
		});
	}

	private async handleGridworldSyncRailEntities(event: messages.GridworldSyncRailEntities) {
		const pathworldId = this.getPathworldInstanceId();
		if (pathworldId === undefined) {
			this.logger.warn("[gridworld] rail sync: no pathworld instance found");
			return;
		}
		const pathworldInstance = this.controller.instances.get(pathworldId);
		if (!pathworldInstance || pathworldInstance.status !== "running") {
			this.logger.warn(`[gridworld] rail sync: pathworld instance ${pathworldId} not running (status=${pathworldInstance?.status ?? "not found"})`);
			return;
		}
		try {
			await this.controller.sendTo(
				{ instanceId: pathworldId },
				new messages.GridworldApplyRailEntities(
					event.tileX,
					event.tileY,
					event.tileSize,
					event.entities,
				),
			);
		} catch (err: any) {
			this.logger.warn(`Failed to forward rail entities to pathworld: ${err?.message ?? err}`);
		}
	}

	private async handleGridworldRequestTrainPath(event: messages.GridworldRequestTrainPath, source: lib.Address) {
		const pathworldId = this.getPathworldInstanceId();
		if (pathworldId === undefined) {
			this.logger.warn("[gridworld] request_train_path: no pathworld instance found");
			return;
		}
		const pathworldInstance = this.controller.instances.get(pathworldId);
		if (!pathworldInstance || pathworldInstance.status !== "running") {
			this.logger.warn(`[gridworld] request_train_path: pathworld instance ${pathworldId} not running (status=${pathworldInstance?.status ?? "not found"})`);
			return;
		}
		try {
			await this.controller.sendTo(
				{ instanceId: pathworldId },
				new messages.GridworldForwardTrainPath(
					event.id,
					event.surface,
					event.position,
					event.direction,
					event.destination,
					source.id,
				),
			);
			this.logger.info(`[gridworld] request_train_path forwarded: train=${event.id} destination=${event.destination} sourceInstance=${source.id} pathworld=${pathworldId}`);
			this.pendingTrainPathDestinations.set(`${source.id}:${event.id}`, event.destination);
		} catch (err: any) {
			this.logger.warn(`[gridworld] Failed to forward train path request to pathworld: ${err?.message ?? err}`);
		}
	}

	private async handleGridworldClearTrainPath(event: messages.GridworldClearTrainPath, source: lib.Address) {
		// Remove pending proxy creation for this train
		const pendingKey = `${source.id}:${event.id}`;
		this.pendingTrainPathDestinations.delete(pendingKey);

		// Forward to pathworld to clear any queued request
		const pathworldId = this.getPathworldInstanceId();
		if (pathworldId === undefined) return;
		const pathworldInstance = this.controller.instances.get(pathworldId);
		if (!pathworldInstance || pathworldInstance.status !== "running") return;
		try {
			await this.controller.sendTo(
				{ instanceId: pathworldId },
				new messages.GridworldForwardClearTrainPath(event.id),
			);
		} catch (err: any) {
			this.logger.warn(`[gridworld] Failed to forward clear_train_path to pathworld: ${err?.message ?? err}`);
		}
	}

	private async handleGridworldRemoveTrainProxy(event: messages.GridworldRemoveTrainProxy, source: lib.Address) {
		const ue = this.getUniversalEdgesController();
		if (!ue?.edgeDatastore) return;

		const edgeId = event.lastEdgeStop.split(" ")[0];
		const edge = ue.edgeDatastore.get(edgeId);
		if (!edge) return;
		const destinationInstanceId = (edge.source.instanceId === source.id)
			? edge.target.instanceId
			: edge.source.instanceId;

		const destInstance = this.controller.instances.get(destinationInstanceId);
		if (!destInstance || destInstance.status !== "running") return;

		try {
			await this.controller.sendTo(
				{ instanceId: destinationInstanceId },
				new messages.GridworldForwardRemoveTrainProxy(event.destination),
			);
		} catch (err: any) {
			this.logger.warn(`[gridworld] Failed to forward remove_train_proxy: ${err?.message ?? err}`);
		}
	}

	private async handleGridworldReturnTrainPathResult(event: messages.GridworldReturnTrainPathResult) {
		const sourceInstance = this.controller.instances.get(event.sourceInstanceId);
		if (!sourceInstance) {
			this.logger.warn(`[gridworld] return_train_path: source instance ${event.sourceInstanceId} not found for train=${event.id}`);
			return;
		}
		if (sourceInstance.status !== "running") {
			this.logger.warn(`[gridworld] return_train_path: source instance ${event.sourceInstanceId} not running (status=${sourceInstance.status}) for train=${event.id}`);
			return;
		}
		try {
			await this.controller.sendTo(
				{ instanceId: event.sourceInstanceId },
				new messages.GridworldReturnTrainPath(event.id, event.path),
			);
			this.logger.info(`[gridworld] return_train_path forwarded: train=${event.id} to instance=${event.sourceInstanceId}`);
		} catch (err: any) {
			this.logger.warn(`[gridworld] Failed to forward train path result to instance ${event.sourceInstanceId}: ${err?.message ?? err}`);
		}

		// Send proxy train creation to the destination instance
		const pendingKey = `${event.sourceInstanceId}:${event.id}`;
		const destination = this.pendingTrainPathDestinations.get(pendingKey);
		this.pendingTrainPathDestinations.delete(pendingKey);
		if (!destination || event.path.length === 0) {
			return;
		}

		// Resolve destination instance by walking the path edges
		const ue = this.getUniversalEdgesController();
		if (!ue?.edgeDatastore) {
			return;
		}
		let currentInstanceId = event.sourceInstanceId;
		for (const stopName of event.path) {
			const edgeId = stopName.split(" ")[0];
			const edge = ue.edgeDatastore.get(edgeId);
			if (!edge) {
				this.logger.warn(`[gridworld] create_train_proxy path walk: edge ${edgeId} not in datastore, skipping`);
				continue;
			}
			currentInstanceId = (edge.source.instanceId === currentInstanceId)
				? edge.target.instanceId
				: edge.source.instanceId;
		}
		const destinationInstanceId = currentInstanceId;
		// this.logger.info(`[gridworld] create_train_proxy path walk: sourceInstance=${event.sourceInstanceId} hops=${event.path.length} destinationInstance=${destinationInstanceId}`);

		// Parse edge ID and offset from the last path entry
		const lastStop = event.path[event.path.length - 1];
		const lastEdgeId = lastStop.split(" ")[0];
		const lastOffset = Number(lastStop.split(" ")[1]);

		const destInstance = this.controller.instances.get(destinationInstanceId);
		if (!destInstance || destInstance.status !== "running") {
			this.logger.warn(`[gridworld] create_train_proxy: destination instance ${destinationInstanceId} not available`);
			return;
		}

		try {
			await this.controller.sendTo(
				{ instanceId: destinationInstanceId },
				new messages.GridworldCreateTrainProxy(destination, lastEdgeId, lastOffset),
			);
			this.logger.info(`[gridworld] create_train_proxy sent: destination="${destination}" edgeId=${lastEdgeId} offset=${lastOffset} instance=${destinationInstanceId}`);
		} catch (err: any) {
			this.logger.warn(`[gridworld] Failed to send create_train_proxy: ${err?.message ?? err}`);
		}
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
				await this.controller.instances.deleteInstance(tile.instanceId);
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
			if (!name.startsWith(namePrefix) && name !== "pathworld") {
				continue;
			}
			await this.stopInstanceBeforeDelete(instance.id, name);
			try {
				await this.controller.instances.deleteInstance(instance.id);
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
			await this.createPathworldInstance();
			await this.ensureTile(x, y, "reset");
		}
		this.markStateDirty();
	}

	private getPathworldInstanceId(): number | undefined {
		for (const instance of this.controller.instances.values()) {
			if (instance.config.get("instance.name") === "pathworld") {
				return instance.id;
			}
		}
		return undefined;
	}

	private async syncTileAreasToPathworld(tilesToSync?: TileRecord[]) {
		const pathworldId = this.getPathworldInstanceId();
		if (pathworldId === undefined) {
			return;
		}
		const pathworldInstance = this.controller.instances.get(pathworldId);
		if (!pathworldInstance || pathworldInstance.status !== "running") {
			return;
		}
		const tileSize = this.controller.config.get("gridworld.tile_size");
		const surfaceName = this.controller.config.get("gridworld.surface_name");
		const source = tilesToSync ?? [...this.tiles.values()];
		const tiles = source.map(tile => {
			const half = tileSize / 2;
			const centerX = tile.x * tileSize;
			const centerY = tile.y * tileSize;
			return {
				minX: centerX - half,
				maxX: centerX + half,
				minY: centerY - half,
				maxY: centerY + half,
				surfaceName,
			};
		});
		if (!tiles.length) {
			return;
		}
		try {
			await this.controller.sendTo(
				{ instanceId: pathworldId },
				new messages.GridworldSyncTileAreas(tiles),
			);
		} catch (err: any) {
			this.logger.warn(`Failed to send tile bounds to pathworld: ${err?.message ?? err}`);
		}
	}

	private async createPathworldInstance() {
		const initialX = this.controller.config.get("gridworld.initial_tile_x");
		const initialY = this.controller.config.get("gridworld.initial_tile_y");
		const mapSettings = this.buildMapSettingsForTile(initialX, initialY);
		if (!mapSettings) {
			this.logger.error(`Cannot create pathworld instance: ${this.mapExchangeError ?? "map exchange string is not configured."}`);
			return;
		}
		const hostId = this.getHostIdForTile();
		if (hostId === undefined) {
			this.logger.error("Cannot create pathworld instance: no hosts connected.");
			return;
		}

		const instanceName = "pathworld";
		const saveName = "pathworld.zip";

		const instanceConfig = new lib.InstanceConfig("controller");
		instanceConfig.set("instance.name", instanceName, "controller");
		instanceConfig.set("instance.auto_start", true, "controller");
		// instanceConfig.set("factorio.settings", { public: false, lan: false }, "controller");

		await this.controller.instances.createInstance(instanceConfig);
		const instanceId = instanceConfig.get("instance.id");

		try {
			await this.controller.instances.assignInstance(instanceId, hostId);
		} catch (err: any) {
			this.logger.error(`Failed to assign pathworld instance ${instanceId}: ${err?.message ?? err}`);
			try {
				await this.controller.instances.deleteInstance(instanceId);
			} catch { /* ignore */ }
			return;
		}

		const hasSave = [...this.controller.saves.values()].some(save =>
			save.instanceId === instanceId && save.name === saveName && !save.isDeleted
		);

		if (!hasSave) {
			try {
				await this.controller.sendTo(
					{ instanceId },
					new lib.InstanceCreateSaveRequest(
						saveName,
						mapSettings.seed,
						mapSettings.mapGenSettings,
						mapSettings.mapSettings,
					),
				);
			} catch (err: any) {
				this.logger.error(`Failed creating save for pathworld: ${err?.message ?? err}`);
				return;
			}
		}

		try {
			await this.controller.sendTo(
				{ instanceId },
				new lib.InstanceStartRequest(saveName),
			);
			this.logger.info(`Started pathworld instance ${instanceId}`);
		} catch (err: any) {
			this.logger.error(`Failed starting pathworld instance ${instanceId}: ${err?.message ?? err}`);
			return;
		}

		// Wait for pathworld to reach "running" so that subsequent syncTileAreasToPathworld calls succeed.
		const deadline = Date.now() + 60_000;
		while (Date.now() < deadline) {
			const updated = this.controller.instances.get(instanceId);
			if (updated?.status === "running") {
				break;
			}
			/* eslint-disable-next-line no-await-in-loop */
			await new Promise(resolve => setTimeout(resolve, 500));
		}

		await this.syncTileAreasToPathworld();
	}

	private getMsPerDay(): number {
		const ticksPerDay = this.controller.config.get("gridworld.ticks_per_day");
		return (ticksPerDay / 60) * 1000;
	}

	private getCanonicalDaytime(): number {
		const elapsed = Date.now() - this.timeEpoch.epochMs;
		return ((this.timeEpoch.epochDaytime + elapsed / this.getMsPerDay()) % 1.0 + 1.0) % 1.0;
	}

	private async loadTimeEpoch() {
		const filePath = path.resolve(
			this.controller.config.get("controller.database_directory"),
			"gridworld_time.json",
		);
		try {
			const content = await fs.readFile(filePath, "utf8");
			const parsed = JSON.parse(content) as TimeEpoch;
			if (Number.isFinite(parsed.epochMs) && Number.isFinite(parsed.epochDaytime)) {
				this.timeEpoch = parsed;
				return;
			}
		} catch (err: any) {
			if (err.code !== "ENOENT") {
				this.logger.warn(`Failed loading time epoch: ${err?.message ?? err}`);
			}
		}
		this.timeEpoch = { epochMs: Date.now(), epochDaytime: 0 };
		this.timeEpochDirty = true;
	}

	private async saveTimeEpoch() {
		const filePath = path.resolve(
			this.controller.config.get("controller.database_directory"),
			"gridworld_time.json",
		);
		await lib.safeOutputFile(filePath, JSON.stringify(this.timeEpoch, null, "\t"));
	}

	private async sendDaytimeToInstance(instanceId: number, isStartup: boolean) {
		const daytime = this.getCanonicalDaytime();
		const ticksPerDay = this.controller.config.get("gridworld.ticks_per_day");
		await this.controller.sendTo(
			{ instanceId },
			new messages.GridworldSyncDaytime(daytime, isStartup, ticksPerDay),
		);
	}

	private async broadcastDaytime(isStartup: boolean) {
		const daytime = this.getCanonicalDaytime();
		const ticksPerDay = this.controller.config.get("gridworld.ticks_per_day");
		this.logger.info(`[gridworld] broadcasting daytime=${daytime.toFixed(4)} isStartup=${isStartup} tiles=${this.tiles.size} ticksPerDay=${ticksPerDay}`);
		for (const tile of this.tiles.values()) {
			const instance = this.controller.instances.get(tile.instanceId);
			if (!instance || instance.status !== "running") {
				continue;
			}
			if (instance.config.get("instance.name") === "pathworld") {
				continue;
			}
			try {
				await this.controller.sendTo(
					{ instanceId: tile.instanceId },
					new messages.GridworldSyncDaytime(daytime, isStartup, ticksPerDay),
				);
			} catch (err: any) {
				this.logger.warn(
					`Failed sending daytime to instance ${tile.instanceId}: ${err?.message ?? err}`,
				);
			}
		}
	}

	private async removeEdgesForTiles(tiles: TileRecord[]) {
		const ue = this.getUniversalEdgesController();
		if (!ue?.edgeDatastore) {
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
			if (ue.edgeDatastore.has(edgeId)) {
				ue.edgeDatastore.delete(edgeId);
				ue.storageDirty = true;
			}
		}
	}
}
