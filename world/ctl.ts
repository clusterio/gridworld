import * as lib from "@clusterio/lib";
import {
	TileCreateRequest, WorldCreateRequest, WorldDeleteRequest, WorldGetRequest, type TileStatus,
} from "./contracts.js";

/** The parts of clusterioctl's plugin context this entrypoint uses (CtlPluginContext lives in @clusterio/ctl). */
type CtlContext = { hooks: { addCommands: lib.AsyncHook<[lib.CommandTree]> }; plugin: { name: string } };
type CreateArgs = {
	tileSize?: number; ticksPerDay?: number; mapExchangeString?: string; exclude?: string[]; seed?: number;
};

function out(text: string) {
	process.stdout.write(`${text}\n`);
}

function line(t: TileStatus): string {
	const planets = t.planets?.length ? t.planets.join(",") : "-";
	return `${t.x},${t.y} instance ${t.instanceId ?? "-"} host ${t.host ?? "-"} ${t.status ?? "no-instance"} ` +
		`planets ${planets}`;
}

const worldCommands = new lib.CommandTree({ name: "world", description: "The world: create, show, delete" });
worldCommands.add(new lib.Command({
	definition: ["create", "Create the world and plan tile (0,0); refused while a world exists", yargs => {
		yargs.options({
			"tile-size": {
				describe: "Tile size in map tiles: a multiple of 64 from 64 to 4096 (default 512)", type: "number",
			},
			"ticks-per-day": {
				describe: "The base planet's (Nauvis's) day in ticks, at least 1200 (default 25000)", type: "number",
			},
			"map-exchange-string": { describe: "Map exchange string for the seed and map settings", type: "string" },
			seed: {
				describe: "Map seed, 0 to 4294967295 (default: the exchange string's, else random)", type: "number",
			},
			exclude: {
				describe: "A planet no tile creates (repeatable); frozen with the world. " +
					"A name the pack lacks is allowed",
				type: "string", array: true,
			},
		});
	}],
	handler: async (args: CreateArgs, control: lib.Link) => {
		const request = new WorldCreateRequest(
			args.tileSize, args.mapExchangeString, args.ticksPerDay, args.exclude, args.seed,
		);
		const { layout } = await control.send(request);
		out(layout.world?.id ?? "");
	},
}));
worldCommands.add(new lib.Command({
	definition: ["show", "Show the world and each tile's instance id, host and status", yargs => {
		yargs.options({ json: { describe: "Print the response as JSON", type: "boolean", default: false } });
	}],
	handler: async (args: { json: boolean }, control: lib.Link) => {
		const shown = await control.send(new WorldGetRequest());
		if (args.json) {
			out(JSON.stringify(shown));
			return;
		}
		const world = shown.layout?.world;
		if (!world) {
			out("no world");
			return;
		}
		const deleting = world.deleting ? " (deleting)" : "";
		out(`world ${world.id}${deleting}, tile size ${world.tileSize}, surface ${world.surface}`);
		for (const t of shown.tiles) {
			out(line(t));
		}
	},
}));
worldCommands.add(new lib.Command({
	definition: ["delete", "Delete the world: stops and deletes every gridworld_* and pathworld instance", yargs => {
		yargs.options({ confirm: { describe: "Required: confirms the deletion", type: "boolean", default: false } });
	}],
	handler: async (args: { confirm: boolean }, control: lib.Link) => {
		if (!args.confirm) {
			throw new lib.CommandError("world delete deletes every gridworld_* and pathworld instance: add --confirm");
		}
		await control.send(new WorldDeleteRequest(true));
	},
}));

const tileCommands = new lib.CommandTree({ name: "tile", description: "Tiles: plan one" });
tileCommands.add(new lib.Command({
	definition: ["create <x> <y>", "Plan a tile: gridworld creates its instance, places it and starts it", yargs => {
		yargs.positional("x", { describe: "Tile x", type: "number" });
		yargs.positional("y", { describe: "Tile y", type: "number" });
	}],
	handler: async (args: { x: number; y: number }, control: lib.Link) => {
		await control.send(new TileCreateRequest(args.x, args.y));
	},
}));

const gridworldCommands = new lib.CommandTree({
	name: "gridworld",
	description: "Gridworld v2: gridworld starts a tile when it is created and when a player joins a tile next to it",
});
gridworldCommands.add(worldCommands);
gridworldCommands.add(tileCommands);

/** clusterioctl entrypoint (SP2 spec §4): `clusterioctl gridworld world|tile …`. */
export default async function loadCtlPlugin(context: CtlContext) {
	context.hooks.addCommands.attach(context.plugin.name, async rootCommand => {
		rootCommand.add(gridworldCommands);
	});
}
