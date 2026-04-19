import * as lib from "@clusterio/lib";
import * as messages from "./messages";

lib.definePermission({
	name: "gridworld.view",
	title: "View gridworld",
	description: "View gridworld tiles and status",
	grantByDefault: true,
});

lib.definePermission({
	name: "gridworld.manage",
	title: "Manage gridworld",
	description: "Create or delete gridworld tiles",
});

declare module "@clusterio/lib" {
	export interface ControllerConfigFields {
		"gridworld.map_exchange_string": string;
		"gridworld.tile_size": number;
		"gridworld.surface_name": string;
		"gridworld.initial_tile_x": number;
		"gridworld.initial_tile_y": number;
		"gridworld.auto_start_instances": boolean;
		"gridworld.save_name_prefix": string;
		"gridworld.ticks_per_day": number;
	}
	export interface InstanceConfigFields {
		"gridworld.tile_x": number;
		"gridworld.tile_y": number;
		"gridworld.tile_size": number;
		"gridworld.surface_name": string;
	}
}

export const plugin: lib.PluginDeclaration = {
	name: "gridworld",
	title: "Gridworld",
	description: "Creates an infinite tiled world backed by Universal Edges.",

	controllerEntrypoint: "./dist/node/controller",
	controllerConfigFields: {
		"gridworld.map_exchange_string": {
			title: "Map Exchange String",
			description: "Map exchange string used to generate tiles.",
			type: "string",
			initialValue: ">>>eNpjYmBg8AFiBh6W5PzEHAaGBnsY5krOLyhILdLNL0pFFuZMLipNSdXNz0RVnJqXmlupm5RYjKKYI7MoPw/dBJ68xNKyzOL45JzMtDRkCdai/OTsYmQRseKSxKKSzLz0+MSi1MT43PzM4pJSVNNYi0vy81BFSopSU1GM4S4tSszLLM1FdwlreWJJahGyCANj2XeTFw0tcgwg/L+eQeH/fxAGsh4AQwmEGRgbIKoZgYIwwAr1DIOCIxA7IYxjZKwWWef+sGqKPSNEpZ4DlPEBKnIgCSbiCWP4OeCUUoExTJDMMQaDz0gMiKUlQCugqjgcEAyIZAtIkpGx9+3WBd+PXbBj/LPy4yXfpAR7RkNXkXcfjNbZASXZQd5lghOzZoLATphXGGBmPrCHSt20Zzx7BgTe2DOygnSIgAgHCyBxwJuZgVGAD8ha0AMkFGQYYE6zgxkj4sCYBgbfYD55DGNctkf3BzAgbECGy4GIEyACbCHcZYwQpkO/A6ODPExWEqEEqN+IAdkNKQgfnoRZexjJfjSHYEYEsj/QRFQcsEQDF8jCFDjxghnuGmB4XmCH8RzmOzAygxggVV+AYhAeSAZmFIQWcAAHNzM8UX6wR01pIAbIkCB3zfkAC3S/Eg==<<<",
		},
		"gridworld.tile_size": {
			title: "Tile Size",
			description: "Tile size in map units (tiles).",
			type: "number",
			initialValue: 1024,
		},
		"gridworld.surface_name": {
			title: "Surface Name",
			description: "Surface name to use for edge endpoints.",
			type: "string",
			initialValue: "nauvis",
		},
		"gridworld.initial_tile_x": {
			title: "Initial Tile X",
			description: "X coordinate of the initial tile.",
			type: "number",
			initialValue: 0,
		},
		"gridworld.initial_tile_y": {
			title: "Initial Tile Y",
			description: "Y coordinate of the initial tile.",
			type: "number",
			initialValue: 0,
		},
		"gridworld.auto_start_instances": {
			title: "Auto Start Instances",
			description: "Legacy setting (ignored). Instances now start as players explore.",
			type: "boolean",
			initialValue: false,
		},
		"gridworld.save_name_prefix": {
			title: "Save Name Prefix",
			description: "Prefix to use for tile save names.",
			type: "string",
			initialValue: "gridworld",
		},
		"gridworld.ticks_per_day": {
			title: "Ticks Per Day",
			description: "Length of a full day/night cycle in game ticks. Factorio default is 25000 (~7 min at 60 UPS). Use higher values for longer days.",
			type: "number",
			initialValue: 25000,
		},
	},

	instanceEntrypoint: "./dist/node/instance",
	instanceConfigFields: {
		"gridworld.tile_x": {
			title: "Tile X",
			description: "Tile X coordinate (managed by gridworld).",
			type: "number",
			initialValue: 0,
		},
		"gridworld.tile_y": {
			title: "Tile Y",
			description: "Tile Y coordinate (managed by gridworld).",
			type: "number",
			initialValue: 0,
		},
		"gridworld.tile_size": {
			title: "Tile Size",
			description: "Tile size in map units (managed by gridworld).",
			type: "number",
			initialValue: 1024,
		},
		"gridworld.surface_name": {
			title: "Surface Name",
			description: "Surface name to use for gridworld boundaries (managed by gridworld).",
			type: "string",
			initialValue: "nauvis",
		},
	},

	messages: [
		messages.GridworldStateUpdate,
		messages.GridworldStateRequest,
		messages.GridworldCreateRequest,
		messages.GridworldDeleteRequest,
		messages.GridworldSyncTileAreas,
		messages.GridworldSyncRailEntities,
		messages.GridworldApplyRailEntities,
		messages.GridworldRequestTrainPath,
		messages.GridworldForwardTrainPath,
		messages.GridworldReturnTrainPathResult,
		messages.GridworldReturnTrainPath,
		messages.GridworldSyncUeStops,
		messages.GridworldApplyUeStops,
		messages.GridworldSyncDaytime,
		messages.GridworldCreateTrainProxy,
		messages.GridworldClearTrainPath,
		messages.GridworldForwardClearTrainPath,
		messages.GridworldRemoveTrainProxy,
		messages.GridworldForwardRemoveTrainProxy,
		messages.GridworldCornerNeighbors,
		messages.GridworldCornerTeleportPlayer,
		messages.GridworldDiagonalEntityTransfer,
	],

	webEntrypoint: "./web",
	routes: [
		"/gridworld",
	],
};
