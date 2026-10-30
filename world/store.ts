import { randomInt } from "node:crypto";
import * as lib from "@clusterio/lib";
import { lifecycle, newId } from "universal_edges/runtime";
import { WorldFileSchema, type Layout, type Tile, type World, type WorldFile } from "./contracts.js";
import { bounds, newTile, tileKey } from "./grid.js";

export type StoreIo = {
	save(data: WorldFile): Promise<void>;
	/** After each successful write: the header and the tiles whose structural change it carried (§13). */
	published(layout: Layout): void;
};

export type CreateOptions = { tileSize?: number; mapExchangeString?: string; ticksPerDay?: number;
	exclude?: string[]; seed?: number;
};

/** Why a tile was planned (§16): world creation, `tile create`, a join next door, or a missing instance replaced. */
export type PlanReason = "world" | "tile_create" | "join" | "missing";

const validFile = lib.compile<WorldFile>(WorldFileSchema as any);

/** A loaded file's data, or an empty record; a malformed file throws, so GW never acts on a corrupt world. */
export function fileData(data: unknown): WorldFile {
	if (data === undefined) {
		return { world: null };
	}
	if (!validFile(data)) {
		throw new Error(`gridworld_world.json is malformed: ${JSON.stringify(validFile.errors)}`);
	}
	return data;
}

/** §13's layout of the given tiles. */
export function layoutOf(world: World | null, tiles: Tile[]): Layout {
	if (!world) {
		return { world: null, tiles: [] };
	}
	const { id, tileSize, surface, createdAtMs, deleting } = world;
	return {
		world: { id, tileSize, surface, createdAtMs, deleting },
		tiles: tiles.map(t => ({
			x: t.x, y: t.y, instanceId: t.instanceId, bounds: bounds(tileSize, t.x, t.y), updatedAtMs: t.updatedAtMs,
		})),
	};
}

/**
 * The world record (SP2 spec §5.1): the writes of one event-loop turn share one save, and callers act only after it
 * resolves (persist, then act). Each successful write publishes the structural changes it carried (§13).
 */
export class WorldStore {
	private changed = new Set<string>();
	private headerChanged = false;
	private lastMs: number;
	private turn?: Promise<void>;
	/** The last write's outcome: it rejects when that write failed. */
	private last: Promise<void> = Promise.resolve();
	private chain: Promise<void> = Promise.resolve();

	constructor(
		public data: WorldFile,
		private io: StoreIo,
		private logger: lib.Logger,
		private now: () => number = Date.now,
	) {
		// Stamps stay above every stored one, even if the clock went back across a restart (§13's replay).
		this.lastMs = Object.values(data.world?.tiles ?? {}).reduce((max, t) => Math.max(max, t.updatedAtMs), 0);
	}

	get world(): World | null {
		return this.data.world;
	}

	/** The last structural change's stamp: it moves whenever a tile changes. */
	get stamp(): number {
		return this.lastMs;
	}

	/** A structural change (§13): a new updatedAtMs, strictly increasing, and the tile goes out with the next write. */
	touch(tile: Tile): void {
		this.lastMs = Math.max(this.now(), this.lastMs + 1);
		tile.updatedAtMs = this.lastMs;
		this.changed.add(tileKey(tile.x, tile.y));
	}

	/** Put a record the planner built (plan.ts returns new objects), as a structural change. */
	put(tile: Tile): void {
		if (this.data.world) {
			this.data.world.tiles[tileKey(tile.x, tile.y)] = tile;
			this.touch(tile);
		}
	}

	/**
	 * Resolves once every change made before the call is written: the writes of one turn share one save. With
	 * nothing new to write it returns the last write, so a pass can always await it before it acts; it rejects
	 * when that write failed.
	 */
	save(): Promise<void> {
		if (!this.turn && this.changed.size === 0 && !this.headerChanged) {
			return this.last;
		}
		this.turn ??= new Promise<void>(resolve => {
			setImmediate(resolve);
		}).then(() => this.write());
		return this.turn;
	}

	private write(): Promise<void> {
		this.turn = undefined;
		const tiles = this.changed;
		const header = this.headerChanged;
		this.changed = new Set();
		this.headerChanged = false;
		const done = this.chain.then(() => this.io.save(structuredClone(this.data)));
		this.chain = done.catch(() => undefined);
		this.last = done;
		return done.then(() => {
			const world = this.data.world;
			if (tiles.size > 0 || header) {
				const current = [...tiles].map(k => world?.tiles[k]).filter((t): t is Tile => t !== undefined);
				this.io.published(layoutOf(world, current));
			}
		}, (err: Error) => {
			// Planning ruling 10: the change stays in memory and goes out with the next write that lands, with a fresh
			// stamp, so a subscriber that saw a later write still gets it.
			for (const k of tiles) {
				const t = this.data.world?.tiles[k];
				if (t) {
					this.touch(t);
				}
			}
			this.headerChanged ||= header;
			throw err;
		});
	}

	/** The subscription's replay (§13): the tiles updated after sinceMs; 0 gives every tile. */
	layout(sinceMs = 0): Layout {
		const world = this.data.world;
		return layoutOf(world, world ? Object.values(world.tiles).filter(t => t.updatedAtMs > sinceMs) : []);
	}

	/**
	 * §14: refused while a world exists, deleting or not. T, B and the exclude list (surfaces spec §4.2, S4) are
	 * checked and frozen; an exchange string gives the seed and the map settings, and a given seed overrides its seed.
	 * Tile (0,0) is planned with it.
	 */
	async createWorld(opts: CreateOptions): Promise<World> {
		if (this.data.world) {
			throw new lib.ConflictError(`world ${this.data.world.id} exists; delete it first`);
		}
		const tileSize = opts.tileSize ?? 512;
		if (!Number.isInteger(tileSize) || tileSize < 64 || tileSize > 4096 || tileSize % 64 !== 0) {
			throw new lib.ValidationError(`tile size ${tileSize} must be a multiple of 64 from 64 to 4096`);
		}
		const ticksPerDay = opts.ticksPerDay ?? 25000;
		// Surfaces spec §4.2 (S6): at least 1200, so the base planet's sync period is at least 5 s;
		// D29's 7200 went (A15).
		if (!Number.isInteger(ticksPerDay) || ticksPerDay < 1200) {
			throw new lib.ValidationError(`ticks per day ${ticksPerDay} must be an integer of at least 1200`);
		}
		const surface = "nauvis";
		const exclude = opts.exclude ?? [];
		if (exclude.includes(surface)) {
			throw new lib.ValidationError(`the base planet ${surface} can't be excluded`);
		}
		let seed = randomInt(2 ** 32);
		let mapGenSettings: Record<string, unknown> | undefined;
		let mapSettings: Record<string, unknown> | undefined;
		if (opts.mapExchangeString !== undefined) {
			let parsed: ReturnType<typeof lib.readMapExchangeString>;
			try {
				parsed = lib.readMapExchangeString(opts.mapExchangeString);
			} catch (err: any) {
				throw new lib.ValidationError(`map exchange string: ${err.message}`);
			}
			mapGenSettings = parsed.map_gen_settings as unknown as Record<string, unknown>;
			mapSettings = parsed.map_settings as unknown as Record<string, unknown>;
			seed = parsed.map_gen_settings.seed;
		}
		// A given seed wins over the exchange string's: Clusterio passes it as --map-gen-seed, which overrides
		// map-gen-settings.json's.
		if (opts.seed !== undefined) {
			if (!Number.isInteger(opts.seed) || opts.seed < 0 || opts.seed >= 2 ** 32) {
				throw new lib.ValidationError(`seed ${opts.seed} must be an integer from 0 to 4294967295`);
			}
			seed = opts.seed;
		}
		const now = this.now();
		const world: World = {
			id: newId(), trace: newId(), createdAtMs: now, tileSize, surface, seed, mapGenSettings,
			mapSettings, ticksPerDay, ...(exclude.length > 0 ? { exclude } : {}),
			epochMs: now, epochDaytime: 0, deleting: false, tiles: {},
		};
		const origin = newTile(0, 0, newId(), now);
		world.tiles[tileKey(0, 0)] = origin;
		this.data.world = world;
		this.headerChanged = true;
		this.touch(origin);
		await this.save();
		lifecycle(this.logger, "gw.world", "created", { world: world.id, tileSize, seed, trace: world.trace });
		lifecycle(this.logger, "gw.tile", "planned", { x: 0, y: 0, reason: "world", trace: origin.trace });
		return world;
	}

	/** §14: the request's literal confirm is the confirmation. Deletion itself is reconciled (§6.2). */
	async deleteWorld(): Promise<void> {
		const world = this.data.world;
		if (!world) {
			throw new lib.NotFoundError("there is no world");
		}
		if (world.deleting) {
			await this.save(); // a retry after a failed write lands the change before it reports success
			return;
		}
		world.deleting = true;
		this.headerChanged = true;
		await this.save();
		const { tileSize, seed } = world;
		lifecycle(this.logger, "gw.world", "deleting", { world: world.id, tileSize, seed, trace: world.trace });
	}

	/** §14: no gridworld_* or pathworld instance is left; the record goes. */
	async dropWorld(): Promise<void> {
		const world = this.data.world;
		if (!world?.deleting) {
			return;
		}
		this.data.world = null;
		this.headerChanged = true;
		await this.save();
		const { tileSize, seed } = world;
		lifecycle(this.logger, "gw.world", "deleted", { world: world.id, tileSize, seed, trace: world.trace });
	}

	/** Plan a tile; false when it is planned already. Refused without a live world. */
	async createTile(x: number, y: number, reason: PlanReason): Promise<boolean> {
		const world = this.data.world;
		if (!world) {
			throw new lib.NotFoundError("there is no world");
		}
		if (world.deleting) {
			throw new lib.ConflictError("the world is being deleted");
		}
		if (world.tiles[tileKey(x, y)]) {
			await this.save(); // a retry after a failed write lands the tile before it reports success
			return false;
		}
		const t = newTile(x, y, newId(), this.now());
		world.tiles[tileKey(x, y)] = t;
		this.touch(t);
		await this.save();
		lifecycle(this.logger, "gw.tile", "planned", { x, y, reason, trace: t.trace });
		return true;
	}
}
