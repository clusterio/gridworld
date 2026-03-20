import { plainJson } from "@clusterio/lib";
import { Type, type Static } from "@sinclair/typebox";

const GridworldTile = Type.Object({
	x: Type.Number(),
	y: Type.Number(),
	instanceId: Type.Number(),
	saveName: Type.String(),
	createdAtMs: Type.Number(),
});

export type GridworldTile = Static<typeof GridworldTile>;

export const GridworldStateResponse = Type.Object({
	tiles: Type.Array(GridworldTile),
	tileSize: Type.Number(),
	initialTile: Type.Object({
		x: Type.Number(),
		y: Type.Number(),
	}),
	mapExchangeError: Type.Union([Type.String(), Type.Null()]),
});

export type GridworldStateResponse = Static<typeof GridworldStateResponse>;

export const GridworldStateValue = Type.Intersect([
	Type.Object({
		id: Type.Literal("state"),
		updatedAtMs: Type.Number(),
		isDeleted: Type.Boolean(),
	}),
	GridworldStateResponse,
]);

export type GridworldStateValue = Static<typeof GridworldStateValue>;

export class GridworldStateUpdate {
	declare ["constructor"]: typeof GridworldStateUpdate;
	static type = "event" as const;
	static src = "controller" as const;
	static dst = "control" as const;
	static plugin = "gridworld" as const;
	static permission = "gridworld.view" as const;

	constructor(public updates: GridworldStateValue[]) { }

	static jsonSchema = Type.Object({
		updates: Type.Array(GridworldStateValue),
	});

	static fromJSON(json: Static<typeof this.jsonSchema>) {
		return new this(json.updates);
	}
}

export class GridworldStateRequest {
	declare ["constructor"]: typeof GridworldStateRequest;
	static type = "request" as const;
	static src = "control" as const;
	static dst = "controller" as const;
	static plugin = "gridworld" as const;
	static permission = "gridworld.view" as const;

	static jsonSchema = Type.Object({});
	static Response = plainJson(GridworldStateResponse);

	static fromJSON() {
		return new this();
	}
}

export class GridworldCreateRequest {
	declare ["constructor"]: typeof GridworldCreateRequest;
	static type = "request" as const;
	static src = "control" as const;
	static dst = "controller" as const;
	static plugin = "gridworld" as const;
	static permission = "gridworld.manage" as const;

	static jsonSchema = Type.Object({});
	static Response = plainJson(GridworldStateResponse);

	static fromJSON() {
		return new this();
	}
}

export class GridworldDeleteRequest {
	declare ["constructor"]: typeof GridworldDeleteRequest;
	static type = "request" as const;
	static src = "control" as const;
	static dst = "controller" as const;
	static plugin = "gridworld" as const;
	static permission = "gridworld.manage" as const;

	static jsonSchema = Type.Object({});
	static Response = plainJson(GridworldStateResponse);

	static fromJSON() {
		return new this();
	}
}

export class GridworldSyncTileAreas {
	declare ["constructor"]: typeof GridworldSyncTileAreas;
	static type = "event" as const;
	static src = "controller" as const;
	static dst = "instance" as const;
	static plugin = "gridworld" as const;

	constructor(
		public tiles: Array<{
			minX: number;
			maxX: number;
			minY: number;
			maxY: number;
			surfaceName: string;
		}>,
	) { }

	static jsonSchema = Type.Object({
		tiles: Type.Array(Type.Object({
			minX: Type.Number(),
			maxX: Type.Number(),
			minY: Type.Number(),
			maxY: Type.Number(),
			surfaceName: Type.String(),
		})),
	});

	static fromJSON(json: Static<typeof this.jsonSchema>) {
		return new this(json.tiles);
	}
}

const RailEntity = Type.Object({
	name: Type.String(),
	type: Type.String(),
	surface: Type.String(),
	x: Type.Number(),
	y: Type.Number(),
	direction: Type.Number(),
	// train-stop fields
	stopName: Type.Optional(Type.String()),
	color: Type.Optional(Type.Object({
		r: Type.Number(),
		g: Type.Number(),
		b: Type.Number(),
		a: Type.Number(),
	})),
	priority: Type.Optional(Type.Number()),
	trainLimit: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
	trainCount: Type.Optional(Type.Number()),
});

export type RailEntity = Static<typeof RailEntity>;

export class GridworldSyncRailEntities {
	declare ["constructor"]: typeof GridworldSyncRailEntities;
	static type = "event" as const;
	static src = "instance" as const;
	static dst = "controller" as const;
	static plugin = "gridworld" as const;

	constructor(
		public instanceId: number,
		public tileX: number,
		public tileY: number,
		public tileSize: number,
		public entities: RailEntity[],
	) { }

	static jsonSchema = Type.Object({
		instanceId: Type.Number(),
		tileX: Type.Number(),
		tileY: Type.Number(),
		tileSize: Type.Number(),
		entities: Type.Array(RailEntity),
	});

	static fromJSON(json: Static<typeof this.jsonSchema>) {
		return new this(json.instanceId, json.tileX, json.tileY, json.tileSize, json.entities);
	}
}

export class GridworldApplyRailEntities {
	declare ["constructor"]: typeof GridworldApplyRailEntities;
	static type = "event" as const;
	static src = "controller" as const;
	static dst = "instance" as const;
	static plugin = "gridworld" as const;

	constructor(
		public tileX: number,
		public tileY: number,
		public tileSize: number,
		public entities: RailEntity[],
	) { }

	static jsonSchema = Type.Object({
		tileX: Type.Number(),
		tileY: Type.Number(),
		tileSize: Type.Number(),
		entities: Type.Array(RailEntity),
	});

	static fromJSON(json: Static<typeof this.jsonSchema>) {
		return new this(json.tileX, json.tileY, json.tileSize, json.entities);
	}
}

// Sent from an instance to the controller when a train needs a cross-instance path.
export class GridworldRequestTrainPath {
	declare ["constructor"]: typeof GridworldRequestTrainPath;
	static type = "event" as const;
	static src = "instance" as const;
	static dst = "controller" as const;
	static plugin = "gridworld" as const;

	constructor(
		public id: number,
		public surface: string,
		public position: { x: number; y: number },
		public direction: number,
		public destination: string,
	) { }

	static jsonSchema = Type.Object({
		id: Type.Number(),
		surface: Type.String(),
		position: Type.Object({ x: Type.Number(), y: Type.Number() }),
		direction: Type.Number(),
		destination: Type.String(),
	});

	static fromJSON(json: Static<typeof this.jsonSchema>) {
		return new this(json.id, json.surface, json.position, json.direction, json.destination);
	}
}

// Sent from a source instance to cancel a pending path request.
export class GridworldClearTrainPath {
	declare ["constructor"]: typeof GridworldClearTrainPath;
	static type = "event" as const;
	static src = "instance" as const;
	static dst = "controller" as const;
	static plugin = "gridworld" as const;

	constructor(public id: number) { }

	static jsonSchema = Type.Object({ id: Type.Number() });
	static fromJSON(json: Static<typeof this.jsonSchema>) {
		return new this(json.id);
	}
}

// Forwarded from the controller to the pathworld to cancel a queued path request.
export class GridworldForwardClearTrainPath {
	declare ["constructor"]: typeof GridworldForwardClearTrainPath;
	static type = "event" as const;
	static src = "controller" as const;
	static dst = "instance" as const;
	static plugin = "gridworld" as const;

	constructor(public id: number) { }

	static jsonSchema = Type.Object({ id: Type.Number() });
	static fromJSON(json: Static<typeof this.jsonSchema>) {
		return new this(json.id);
	}
}

// Forwarded from the controller to the pathworld instance to find the path.
export class GridworldForwardTrainPath {
	declare ["constructor"]: typeof GridworldForwardTrainPath;
	static type = "event" as const;
	static src = "controller" as const;
	static dst = "instance" as const;
	static plugin = "gridworld" as const;

	constructor(
		public id: number,
		public surface: string,
		public position: { x: number; y: number },
		public direction: number,
		public destination: string,
		public sourceInstanceId: number,
	) { }

	static jsonSchema = Type.Object({
		id: Type.Number(),
		surface: Type.String(),
		position: Type.Object({ x: Type.Number(), y: Type.Number() }),
		direction: Type.Number(),
		destination: Type.String(),
		sourceInstanceId: Type.Number(),
	});

	static fromJSON(json: Static<typeof this.jsonSchema>) {
		return new this(json.id, json.surface, json.position, json.direction, json.destination, json.sourceInstanceId);
	}
}

// Sent from the pathworld instance to the controller with the resolved path result.
export class GridworldReturnTrainPathResult {
	declare ["constructor"]: typeof GridworldReturnTrainPathResult;
	static type = "event" as const;
	static src = "instance" as const;
	static dst = "controller" as const;
	static plugin = "gridworld" as const;

	constructor(
		public id: number,
		public path: string[],
		public sourceInstanceId: number,
	) { }

	static jsonSchema = Type.Object({
		id: Type.Number(),
		path: Type.Array(Type.String()),
		sourceInstanceId: Type.Number(),
	});

	static fromJSON(json: Static<typeof this.jsonSchema>) {
		return new this(json.id, json.path, json.sourceInstanceId);
	}
}

// Sent from the controller back to the originating instance with the resolved path.
export class GridworldReturnTrainPath {
	declare ["constructor"]: typeof GridworldReturnTrainPath;
	static type = "event" as const;
	static src = "controller" as const;
	static dst = "instance" as const;
	static plugin = "gridworld" as const;

	constructor(
		public id: number,
		public path: string[],
	) { }

	static jsonSchema = Type.Object({
		id: Type.Number(),
		path: Type.Array(Type.String()),
	});

	static fromJSON(json: Static<typeof this.jsonSchema>) {
		return new this(json.id, json.path);
	}
}

// Sent from the controller to the destination instance to create a proxy train for station slot reservation.
export class GridworldCreateTrainProxy {
	declare ["constructor"]: typeof GridworldCreateTrainProxy;
	static type = "event" as const;
	static src = "controller" as const;
	static dst = "instance" as const;
	static plugin = "gridworld" as const;

	constructor(
		public destination: string,
		public edgeId: string,
		public offset: number,
	) { }

	static jsonSchema = Type.Object({
		destination: Type.String(),
		edgeId: Type.String(),
		offset: Type.Number(),
	});

	static fromJSON(json: Static<typeof this.jsonSchema>) {
		return new this(json.destination, json.edgeId, json.offset);
	}
}

const UeStop = Type.Object({
	surface: Type.String(),
	x: Type.Number(),
	y: Type.Number(),
	direction: Type.Number(),
	stopName: Type.Optional(Type.String()),
});

export type UeStop = Static<typeof UeStop>;

// Sent from a tile instance to the controller with its current ue_source_trainstop entities.
export class GridworldSyncUeStops {
	declare ["constructor"]: typeof GridworldSyncUeStops;
	static type = "event" as const;
	static src = "instance" as const;
	static dst = "controller" as const;
	static plugin = "gridworld" as const;

	constructor(
		public tileX: number,
		public tileY: number,
		public stops: UeStop[],
	) { }

	static jsonSchema = Type.Object({
		tileX: Type.Number(),
		tileY: Type.Number(),
		stops: Type.Array(UeStop),
	});

	static fromJSON(json: Static<typeof this.jsonSchema>) {
		return new this(json.tileX, json.tileY, json.stops);
	}
}

// Sent from the controller to tile instances to synchronize day/night cycle.
export class GridworldSyncDaytime {
	declare ["constructor"]: typeof GridworldSyncDaytime;
	static type = "event" as const;
	static src = "controller" as const;
	static dst = "instance" as const;
	static plugin = "gridworld" as const;

	constructor(
		public daytime: number,
		public isStartup: boolean,
		public ticksPerDay: number,
	) { }

	static jsonSchema = Type.Object({
		daytime: Type.Number(),
		isStartup: Type.Boolean(),
		ticksPerDay: Type.Number(),
	});

	static fromJSON(json: Static<typeof this.jsonSchema>) {
		return new this(json.daytime, json.isStartup, json.ticksPerDay);
	}
}

// Sent from source instance when a train cancels; tells controller to remove proxy at destination.
export class GridworldRemoveTrainProxy {
	declare ["constructor"]: typeof GridworldRemoveTrainProxy;
	static type = "event" as const;
	static src = "instance" as const;
	static dst = "controller" as const;
	static plugin = "gridworld" as const;

	constructor(public lastEdgeStop: string, public destination: string) { }

	static jsonSchema = Type.Object({
		lastEdgeStop: Type.String(),
		destination: Type.String(),
	});

	static fromJSON(json: Static<typeof this.jsonSchema>) {
		return new this(json.lastEdgeStop, json.destination);
	}
}

// Forwarded from controller to the destination instance to destroy one proxy train.
export class GridworldForwardRemoveTrainProxy {
	declare ["constructor"]: typeof GridworldForwardRemoveTrainProxy;
	static type = "event" as const;
	static src = "controller" as const;
	static dst = "instance" as const;
	static plugin = "gridworld" as const;

	constructor(public destination: string) { }

	static jsonSchema = Type.Object({
		destination: Type.String(),
	});

	static fromJSON(json: Static<typeof this.jsonSchema>) {
		return new this(json.destination);
	}
}

// Forwarded from the controller to the pathworld instance to apply ue_source_trainstops.
export class GridworldApplyUeStops {
	declare ["constructor"]: typeof GridworldApplyUeStops;
	static type = "event" as const;
	static src = "controller" as const;
	static dst = "instance" as const;
	static plugin = "gridworld" as const;

	constructor(
		public tileX: number,
		public tileY: number,
		public stops: UeStop[],
	) { }

	static jsonSchema = Type.Object({
		tileX: Type.Number(),
		tileY: Type.Number(),
		stops: Type.Array(UeStop),
	});

	static fromJSON(json: Static<typeof this.jsonSchema>) {
		return new this(json.tileX, json.tileY, json.stops);
	}
}
