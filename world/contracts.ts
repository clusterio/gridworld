import * as lib from "@clusterio/lib";
import { Type, type Static } from "@sinclair/typebox";

// Gridworld's contracts (SP2 spec §5): the world file, the tile layout, the Clusterio messages and the payloads Lua
// sends on the bridge. Clusterio checks each message against its jsonSchema when it arrives.

/** The gridworld.tile instance config field (§5.2): the tile config the instance plugin pushes to Lua (§7.3). */
export const TileConfigSchema = Type.Object({
	world: Type.String(),
	x: Type.Integer(),
	y: Type.Integer(),
	size: Type.Integer(),
	surface: Type.String(),
	seed: Type.Integer(),
	trace: Type.String(),
	/** Surfaces spec §4.3: the world's exclude list, when it has one. A config written before it is valid (§5.2). */
	exclude: Type.Optional(Type.Array(Type.String())),
});
export type TileConfig = Static<typeof TileConfigSchema>;

/** A tile's record (§5.1): its instance id is the only state stored; the rest is observed from Clusterio. */
export const TileSchema = Type.Object({
	x: Type.Integer(),
	y: Type.Integer(),
	instanceId: Type.Optional(Type.Integer()),
	trace: Type.String(),
	createdAtMs: Type.Number(),
	updatedAtMs: Type.Number(),
	/** Surfaces spec §4.2: the planet surfaces its instance last reported, sorted; absent until the first (W26). */
	planets: Type.Optional(Type.Array(Type.String())),
});
export type Tile = Static<typeof TileSchema>;

export const WorldSchema = Type.Object({
	id: Type.String(),
	trace: Type.String(),
	createdAtMs: Type.Number(),
	tileSize: Type.Integer(),
	surface: Type.String(),
	seed: Type.Integer(),
	mapGenSettings: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
	mapSettings: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
	ticksPerDay: Type.Integer(),
	/** Surfaces spec §4.2 (S4): planets no tile creates, frozen; absent on a world made before it, meaning none. */
	exclude: Type.Optional(Type.Array(Type.String())),
	epochMs: Type.Number(),
	epochDaytime: Type.Number(),
	deleting: Type.Boolean(),
	tiles: Type.Record(Type.String(), TileSchema),
});
export type World = Static<typeof WorldSchema>;

/** The data of <database>/gridworld_world.json (§5.1). */
export const WorldFileSchema = Type.Object({
	world: Type.Union([WorldSchema, Type.Null()]),
});
export type WorldFile = Static<typeof WorldFileSchema>;

/** The day anchor (§11.1): canonical(t) = (epochDaytime + (t − epochMs) / msPerDay) mod 1. */
export const AnchorSchema = Type.Object({
	epochMs: Type.Number(),
	epochDaytime: Type.Number(),
	ticksPerDay: Type.Integer(),
});
export type Anchor = Static<typeof AnchorSchema>;

const LayoutWorldSchema = Type.Object({
	id: Type.String(),
	tileSize: Type.Integer(),
	surface: Type.String(),
	createdAtMs: Type.Number(),
	deleting: Type.Boolean(),
});
type LayoutWorld = Static<typeof LayoutWorldSchema>;

export const LayoutTileSchema = Type.Object({
	x: Type.Integer(),
	y: Type.Integer(),
	instanceId: Type.Optional(Type.Integer()),
	/** [x1, y1, x2, y2] in world coordinates. */
	bounds: Type.Tuple([Type.Number(), Type.Number(), Type.Number(), Type.Number()]),
	updatedAtMs: Type.Number(),
});
type LayoutTile = Static<typeof LayoutTileSchema>;

/** What a map plugin needs (§13). world null means deleted: a subscriber drops the tiles it holds. */
export const LayoutSchema = Type.Object({
	world: Type.Union([LayoutWorldSchema, Type.Null()]),
	tiles: Type.Array(LayoutTileSchema),
});
export type Layout = Static<typeof LayoutSchema>;

/** A tile as world show prints it: the record, and its instance's status and assigned host observed from Clusterio. */
export const TileStatusSchema = Type.Object({
	x: Type.Integer(),
	y: Type.Integer(),
	instanceId: Type.Optional(Type.Integer()),
	host: Type.Optional(Type.Integer()),
	status: Type.Optional(Type.String()),
	trace: Type.String(),
	planets: Type.Optional(Type.Array(Type.String())),
});
export type TileStatus = Static<typeof TileStatusSchema>;

/** Control → controller: create the world and plan tile (0,0); refused while a world exists (§14). */
export class WorldCreateRequest {
	declare ["constructor"]: typeof WorldCreateRequest;
	static type = "request" as const;
	static src = "control" as const;
	static dst = "controller" as const;
	static plugin = "gridworld" as const;
	static permission = "gridworld.manage" as const;

	constructor(
		public tileSize?: number,
		public mapExchangeString?: string,
		public ticksPerDay?: number,
		public exclude?: string[],
		public seed?: number,
	) { }

	static jsonSchema = Type.Object({
		tileSize: Type.Optional(Type.Integer()),
		mapExchangeString: Type.Optional(Type.String()),
		ticksPerDay: Type.Optional(Type.Integer()),
		exclude: Type.Optional(Type.Array(Type.String())),
		seed: Type.Optional(Type.Integer()),
	});

	static fromJSON(json: Static<typeof WorldCreateRequest.jsonSchema>) {
		return new this(json.tileSize, json.mapExchangeString, json.ticksPerDay, json.exclude, json.seed);
	}

	static Response = lib.plainJson(Type.Object({ layout: LayoutSchema }));
}

/** Control → controller: delete the world (§14). confirm is a literal true: the schema refuses a request without it. */
export class WorldDeleteRequest {
	declare ["constructor"]: typeof WorldDeleteRequest;
	static type = "request" as const;
	static src = "control" as const;
	static dst = "controller" as const;
	static plugin = "gridworld" as const;
	static permission = "gridworld.manage" as const;

	constructor(public confirm: true) { }

	static jsonSchema = Type.Object({ confirm: Type.Literal(true) });

	static fromJSON(json: Static<typeof WorldDeleteRequest.jsonSchema>) {
		return new this(json.confirm);
	}
}

/** Control → controller: the whole layout, each tile's status and host, and the day anchor (§13). */
export class WorldGetRequest {
	declare ["constructor"]: typeof WorldGetRequest;
	static type = "request" as const;
	static src = "control" as const;
	static dst = "controller" as const;
	static plugin = "gridworld" as const;
	static permission = "gridworld.view" as const;
	static Response = lib.plainJson(Type.Object({
		layout: Type.Union([LayoutSchema, Type.Null()]),
		tiles: Type.Array(TileStatusSchema),
		anchor: Type.Optional(AnchorSchema),
	}));
}

/** Control → controller: plan a tile; gridworld creates its instance and starts it (§8, birth). */
export class TileCreateRequest {
	declare ["constructor"]: typeof TileCreateRequest;
	static type = "request" as const;
	static src = "control" as const;
	static dst = "controller" as const;
	static plugin = "gridworld" as const;
	static permission = "gridworld.manage" as const;

	constructor(public x: number, public y: number) { }

	static jsonSchema = Type.Object({ x: Type.Integer(), y: Type.Integer() });

	static fromJSON(json: Static<typeof TileCreateRequest.jsonSchema>) {
		return new this(json.x, json.y);
	}
}

/** Controller → control, by subscription (§13): the world header and only the tiles that changed. */
export class WorldLayoutEvent {
	declare ["constructor"]: typeof WorldLayoutEvent;
	static type = "event" as const;
	static src = "controller" as const;
	static dst = "control" as const;
	static plugin = "gridworld" as const;
	static permission = "gridworld.view" as const;

	constructor(
		public world: LayoutWorld | null,
		public tiles: LayoutTile[],
	) { }

	static jsonSchema = LayoutSchema;

	static fromJSON(json: Static<typeof WorldLayoutEvent.jsonSchema>) {
		return new this(json.world, json.tiles);
	}
}

/** Controller → instance, at every start and hourly (§11.1); sentAtMs is the controller's clock. */
export class DaytimeAnchorEvent {
	declare ["constructor"]: typeof DaytimeAnchorEvent;
	static type = "event" as const;
	static src = "controller" as const;
	static dst = "instance" as const;
	static plugin = "gridworld" as const;

	constructor(
		public epochMs: number,
		public epochDaytime: number,
		public ticksPerDay: number,
		public sentAtMs: number,
	) { }

	static jsonSchema = Type.Object({
		epochMs: Type.Number(),
		epochDaytime: Type.Number(),
		ticksPerDay: Type.Integer(),
		sentAtMs: Type.Number(),
	});

	static fromJSON(json: Static<typeof DaytimeAnchorEvent.jsonSchema>) {
		return new this(json.epochMs, json.epochDaytime, json.ticksPerDay, json.sentAtMs);
	}
}

/** A planet as Lua reports it (surfaces spec §4.5): no ticksPerDay means no day cycle (§9.1, S6). */
export const PlanetDaySchema = Type.Object({ surface: Type.String(), ticksPerDay: Type.Optional(Type.Integer()) });
export type PlanetDay = Static<typeof PlanetDaySchema>;

/** Lua → TS, in answer to every gw.tile.config (surfaces spec §4.1, W25): the planets this tile has. */
export const TilePlanetsPayload = Type.Object({ planets: Type.Array(PlanetDaySchema) });

/** Instance → controller (surfaces spec §4.1): the planet surfaces the sender's tile has, forwarded at every report. */
export class TilePlanetsEvent {
	declare ["constructor"]: typeof TilePlanetsEvent;
	static type = "event" as const;
	static src = "instance" as const;
	static dst = "controller" as const;
	static plugin = "gridworld" as const;

	constructor(public planets: string[]) { }

	static jsonSchema = Type.Object({ planets: Type.Array(Type.String()) });

	static fromJSON(json: Static<typeof TilePlanetsEvent.jsonSchema>) {
		return new this(json.planets);
	}
}

/**
 * Cross-border biters spec §8: a planet's evolution parts (absolute in an apply; in a report, time and the growth of
 * the other two since the tile's last report).
 */
export const EvolutionPlanetSchema = Type.Object({
	surface: Type.String(), time: Type.Number(), pollution: Type.Number(), kills: Type.Number(),
});
export type EvolutionPlanet = Static<typeof EvolutionPlanetSchema>;

/** Lua → TS, every 60 s (spec §8). */
export const EvolutionReportPayload = Type.Object({
	planets: Type.Array(EvolutionPlanetSchema), timeFactor: Type.Number(),
});

/** Instance → controller (spec §8): a tile's evolution report, forwarded. */
export class EvolutionReportEvent {
	declare ["constructor"]: typeof EvolutionReportEvent;
	static type = "event" as const;
	static src = "instance" as const;
	static dst = "controller" as const;
	static plugin = "gridworld" as const;

	constructor(public planets: EvolutionPlanet[], public timeFactor: number) { }

	static jsonSchema = Type.Object({ planets: Type.Array(EvolutionPlanetSchema), timeFactor: Type.Number() });

	static fromJSON(json: Static<typeof EvolutionReportEvent.jsonSchema>) {
		return new this(json.planets, json.timeFactor);
	}
}

/** Controller → instance, every minute while any tile runs (spec §8): each planet's parts, for the tile to set. */
export class EvolutionApplyEvent {
	declare ["constructor"]: typeof EvolutionApplyEvent;
	static type = "event" as const;
	static src = "controller" as const;
	static dst = "instance" as const;
	static plugin = "gridworld" as const;

	constructor(public planets: EvolutionPlanet[]) { }

	static jsonSchema = Type.Object({ planets: Type.Array(EvolutionPlanetSchema) });

	static fromJSON(json: Static<typeof EvolutionApplyEvent.jsonSchema>) {
		return new this(json.planets);
	}
}

/**
 * The biter toggles (owner, 2026-10-10): the gridworld.<key> controller config fields, each on by default. The instance
 * passes them to Lua in gw.tile.config, which applies them at every config.
 */
export const TogglesSchema = Type.Object({
	pollution_border: Type.Boolean(),
	cross_border_raids: Type.Boolean(),
	cross_border_expansion: Type.Boolean(),
	shared_evolution: Type.Boolean(),
});
export type Toggles = Static<typeof TogglesSchema>;

/** Controller → instance: the biter toggles, at every start of a tile and to every running tile when one changes. */
export class TogglesEvent {
	declare ["constructor"]: typeof TogglesEvent;
	static type = "event" as const;
	static src = "controller" as const;
	static dst = "instance" as const;
	static plugin = "gridworld" as const;

	constructor(public toggles: Toggles) { }

	static jsonSchema = Type.Object({ toggles: TogglesSchema });

	static fromJSON(json: Static<typeof TogglesEvent.jsonSchema>) {
		return new this(json.toggles);
	}
}
