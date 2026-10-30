import type * as lib from "@clusterio/lib";
import {
	DaytimeAnchorEvent, EvolutionApplyEvent, EvolutionReportEvent, TileCreateRequest, TilePlanetsEvent, TogglesEvent,
	WorldCreateRequest, WorldDeleteRequest, WorldGetRequest, WorldLayoutEvent, type TileConfig,
} from "./world/contracts.js";

declare module "@clusterio/lib" {
	export interface InstanceConfigFields {
		"gridworld.tile": TileConfig | null;
	}
	export interface ControllerConfigFields {
		"gridworld.pollution_border": boolean;
		"gridworld.cross_border_raids": boolean;
		"gridworld.cross_border_expansion": boolean;
		"gridworld.shared_evolution": boolean;
	}
	export interface Permissions {
		"gridworld.view": never;
		"gridworld.manage": never;
	}
}

const toggle = (title: string, description: string) => (
	{ title, description, type: "boolean" as const, initialValue: true }
);

export const plugin: lib.PluginDeclaration = {
	name: "gridworld",
	title: "Gridworld",
	description: "Infinite tiled world of Clusterio instances stitched together with Universal Edges (v2).",
	controllerEntrypoint: "dist/node/controller.js",
	instanceEntrypoint: "dist/node/instance.js",
	ctlEntrypoint: "dist/node/world/ctl.js",
	webEntrypoint: "./web",
	features: ["SavePatching", "ScriptCommands"],
	// The biter toggles (owner, 2026-10-10): each reaches every running tile within seconds of a change.
	controllerConfigFields: {
		"gridworld.pollution_border": toggle(
			"Pollution border",
			"The border's first-row sweep and the leak report to the neighbour. Off, the second row's sinks still " +
			"absorb what crosses the border, so pollution doesn't spread outside, but nothing reaches the neighbour " +
			"and raids have no virtual pollution to feed on.",
		),
		"gridworld.cross_border_raids": toggle(
			"Cross-border raids",
			"Spawners spend the virtual cloud on raids that cross to the neighbour, and the oracles name their " +
			"targets. Off, the cloud keeps running but buys nothing, no oracle is placed and an arriving raid is " +
			"dropped.",
		),
		"gridworld.cross_border_expansion": toggle(
			"Cross-border expansion",
			"Expansion parties bound past a live border cross and build on the neighbour. Off, they build as " +
			"vanilla (gridworld removes a base outside the tile) and an arriving party is dropped.",
		),
		"gridworld.shared_evolution": toggle(
			"Shared evolution",
			"One evolution per planet for the cluster. Off, tiles don't report and the controller doesn't apply: " +
			"each tile's evolution runs as vanilla from where it is.",
		),
	},
	instanceConfigFields: {
		"gridworld.tile": {
			title: "Gridworld tile",
			description: "Managed by gridworld: the world and tile this instance is. Never edit it.",
			type: "object",
			optional: true,
		},
	},
	messages: [
		WorldCreateRequest,
		WorldDeleteRequest,
		WorldGetRequest,
		TileCreateRequest,
		WorldLayoutEvent,
		DaytimeAnchorEvent,
		TilePlanetsEvent,
		EvolutionReportEvent,
		EvolutionApplyEvent,
		TogglesEvent,
	],
	permissions: [
		{
			name: "gridworld.view",
			title: "View gridworld",
			description: "Show the world and subscribe to its tile layout.",
			grantByDefault: true,
		},
		{
			name: "gridworld.manage",
			title: "Manage gridworld",
			description: "Create and delete the world, and plan tiles.",
		},
	],
};
