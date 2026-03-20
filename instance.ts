import * as lib from "@clusterio/lib";
import { BaseInstancePlugin } from "@clusterio/host";
import * as messages from "./messages";

type RailEntitiesIPC = {
	tile_x: number;
	tile_y: number;
	tile_size: number;
	entities: messages.RailEntity[];
};

type UeStopsIPC = {
	tile_x: number;
	tile_y: number;
	stops: messages.UeStop[];
};

type ReturnTrainPathIPC = {
	id: number;
	path: string[] | Record<string, string>;
	source_instance_id: number;
};

type RequestTrainPathIPC = {
	id: number;
	surface: string;
	position: { x: number; y: number };
	direction: number;
	destination: string;
};

export class InstancePlugin extends BaseInstancePlugin {
	private warnedMissingConfig = false;

	async init() {
		this.instance.handle(messages.GridworldSyncTileAreas, this.handleGridworldSyncTileAreas.bind(this));
		this.instance.handle(messages.GridworldApplyRailEntities, this.handleGridworldApplyRailEntities.bind(this));
		this.instance.handle(messages.GridworldApplyUeStops, this.handleApplyUeStops.bind(this));
		this.instance.handle(messages.GridworldReturnTrainPath, this.handleReturnTrainPath.bind(this));
		this.instance.handle(messages.GridworldForwardTrainPath, this.handleForwardTrainPath.bind(this));
		this.instance.handle(messages.GridworldSyncDaytime, this.handleSyncDaytime.bind(this));
		this.instance.handle(messages.GridworldCreateTrainProxy, this.handleCreateTrainProxy.bind(this));
		this.instance.handle(messages.GridworldForwardClearTrainPath, this.handleForwardClearTrainPath.bind(this));
		this.instance.handle(messages.GridworldForwardRemoveTrainProxy, this.handleForwardRemoveTrainProxy.bind(this));

		// Receive rail entity data collected by Lua via clusterio_api.send_json("gridworld:rail_entities", ...)
		(this.instance.server as any).on("ipc-gridworld:rail_entities", (data: RailEntitiesIPC) => {
			this.handleRailEntitiesIpc(data).catch(err => this.logger.error(
				`Error handling rail entities IPC:\n${err.stack}`,
			));
		});

		// Receive ue_stops data from Lua via clusterio_api.send_json("gridworld:ue_stops", ...)
		(this.instance.server as any).on("ipc-gridworld:ue_stops", (data: UeStopsIPC) => {
			this.handleUeStopsIpc(data).catch(err => this.logger.error(
				`Error handling ue_stops IPC:\n${err.stack}`,
			));
		});

		// Receive train path requests from Lua via clusterio_api.send_json("gridworld:request_train_path", ...)
		(this.instance.server as any).on("ipc-gridworld:request_train_path", (data: RequestTrainPathIPC) => {
			this.handleRequestTrainPathIpc(data).catch(err => this.logger.error(
				`Error handling request_train_path IPC:\n${err.stack}`,
			));
		});

		// Receive train path results from Lua (pathworld) via clusterio_api.send_json("gridworld:return_train_path", ...)
		(this.instance.server as any).on("ipc-gridworld:return_train_path", (data: ReturnTrainPathIPC) => {
			this.handleReturnTrainPathIpc(data).catch(err => this.logger.error(
				`Error handling return_train_path IPC:\n${err.stack}`,
			));
		});

		// Receive clear path request from Lua via clusterio_api.send_json("gridworld:clear_train_path_request", ...)
		(this.instance.server as any).on("ipc-gridworld:clear_train_path_request", (data: { id: number }) => {
			this.instance.sendTo("controller", new messages.GridworldClearTrainPath(data.id));
		});

		// Receive remove proxy request from Lua via clusterio_api.send_json("gridworld:remove_train_proxy", ...)
		(this.instance.server as any).on("ipc-gridworld:remove_train_proxy", (data: { last_edge_stop: string; destination: string }) => {
			this.instance.sendTo("controller", new messages.GridworldRemoveTrainProxy(data.last_edge_stop, data.destination));
		});
	}

	async handleForwardRemoveTrainProxy(event: messages.GridworldForwardRemoveTrainProxy) {
		const json = lib.escapeString(JSON.stringify({ destination: event.destination }));
		await this.sendRcon(`/sc train_path_manager.remove_train_proxies('${json}')`);
	}

	private getBoundaryConfig(logMissing: boolean): { tileX: number; tileY: number; tileSize: number; surfaceName: string } | null {
		const tileX = this.instance.config.get("gridworld.tile_x");
		const tileY = this.instance.config.get("gridworld.tile_y");
		const tileSize = this.instance.config.get("gridworld.tile_size");
		const surfaceName = this.instance.config.get("gridworld.surface_name");

		if (
			typeof tileX !== "number"
			|| typeof tileY !== "number"
			|| typeof tileSize !== "number"
			|| typeof surfaceName !== "string"
		) {
			if (logMissing && !this.warnedMissingConfig) {
				this.logger.warn("Missing gridworld boundary config; skipping boundary setup.");
				this.warnedMissingConfig = true;
			}
			return null;
		}

		return {
			tileX,
			tileY,
			tileSize,
			surfaceName,
		};
	}

	private isPathworld(): boolean {
		return this.instance.config.get("instance.name") === "pathworld";
	}

	private async sendBoundaryConfig(logMissing: boolean) {
		if (this.isPathworld()) {
			return;
		}
		const config = this.getBoundaryConfig(logMissing);
		if (!config) {
			return;
		}
		const escapedSurfaceName = lib.escapeString(config.surfaceName);
		await this.sendRcon(
			`/sc gridworld.set_config({tile_x = ${config.tileX}, tile_y = ${config.tileY}, tile_size = ${config.tileSize}, surface_name = "${escapedSurfaceName}"})`,
		);
	}

	async onInstanceConfigFieldChanged(field: string) {
		if (!field.startsWith("gridworld.")) {
			return;
		}
		if (
			field !== "gridworld.tile_x"
			&& field !== "gridworld.tile_y"
			&& field !== "gridworld.tile_size"
			&& field !== "gridworld.surface_name"
		) {
			return;
		}
		await this.sendBoundaryConfig(false);
	}

	async handleGridworldSyncTileAreas(event: messages.GridworldSyncTileAreas) {
		const tilesJson = lib.escapeString(JSON.stringify(event.tiles));
		await this.sendRcon(`/sc gridworld.sync_tile_areas('${tilesJson}')`);
	}

	async onStart() {
		if (this.isPathworld()) {
			await this.sendRcon("/sc gridworld.set_pathworld()");
		} else {
			await this.sendBoundaryConfig(true);
		}
	}

	private async handleRailEntitiesIpc(data: RailEntitiesIPC) {
		const instanceId = this.instance.config.get("instance.id") as number;
		const entities: messages.RailEntity[] = Array.isArray(data.entities) ? data.entities : Object.values(data.entities as any);
		this.instance.sendTo("controller", new messages.GridworldSyncRailEntities(
			instanceId,
			data.tile_x,
			data.tile_y,
			data.tile_size,
			entities,
		));
	}

	async handleGridworldApplyRailEntities(event: messages.GridworldApplyRailEntities) {
		const json = lib.escapeString(JSON.stringify({
			tile_x:    event.tileX,
			tile_y:    event.tileY,
			tile_size: event.tileSize,
			entities:  event.entities,
		}));
		await this.sendRcon(`/sc rail_sync_manager.apply_rail_entities('${json}')`);
	}

	private async handleUeStopsIpc(data: UeStopsIPC) {
		const stops: messages.UeStop[] = Array.isArray(data.stops) ? data.stops : Object.values(data.stops as any);
		this.instance.sendTo("controller", new messages.GridworldSyncUeStops(
			data.tile_x,
			data.tile_y,
			stops,
		));
	}

	async handleApplyUeStops(event: messages.GridworldApplyUeStops) {
		const json = lib.escapeString(JSON.stringify({
			tile_x: event.tileX,
			tile_y: event.tileY,
			stops:  event.stops,
		}));
		await this.sendRcon(`/sc rail_sync_manager.apply_ue_stops('${json}')`);
	}

	private async handleRequestTrainPathIpc(data: RequestTrainPathIPC) {
		// Normalize position — Factorio MapPosition may serialize as {"1":x,"2":y} instead of {"x":x,"y":y}
		const pos = data.position as any;
		const position = { x: pos.x ?? pos["1"] ?? 0, y: pos.y ?? pos["2"] ?? 0 };
		this.logger.info(`[gridworld] request_train_path IPC received: train=${data.id} destination="${data.destination}" pos=${position.x},${position.y}`);
		this.instance.sendTo("controller", new messages.GridworldRequestTrainPath(
			data.id,
			data.surface,
			position,
			data.direction,
			data.destination
		));
	}

	private async handleReturnTrainPathIpc(data: ReturnTrainPathIPC) {
		// Factorio serializes an empty Lua table as {} (object) not [] (array).
		// Normalize path to always be an array.
		const path: string[] = Array.isArray(data.path) ? data.path : Object.values(data.path as any);
		this.logger.info(`[gridworld] return_train_path IPC received from pathworld: train=${data.id} sourceInstance=${data.source_instance_id} pathLen=${path.length}`);
		this.instance.sendTo("controller", new messages.GridworldReturnTrainPathResult(
			data.id,
			path,
			data.source_instance_id,
		));
	}

	async handleReturnTrainPath(event: messages.GridworldReturnTrainPath) {
		this.logger.info(`[gridworld] return_train_path received: train=${event.id}`);
		const json = lib.escapeString(JSON.stringify({ id: event.id, path: event.path }));
		await this.sendRcon(`/sc train_path_manager.apply_train_path_result('${json}')`);
	}

	async handleSyncDaytime(event: messages.GridworldSyncDaytime) {
		const json = lib.escapeString(JSON.stringify({
			daytime: event.daytime,
			is_startup: event.isStartup,
			ticks_per_day: event.ticksPerDay,
		}));
		await this.sendRcon(`/sc time_sync_manager.apply_canonical_daytime('${json}')`);
	}

	async handleCreateTrainProxy(event: messages.GridworldCreateTrainProxy) {
		this.logger.info(`[gridworld] create_train_proxy received: destination="${event.destination}" edgeId=${event.edgeId} offset=${event.offset}`);
		const json = lib.escapeString(JSON.stringify({
			destination: event.destination,
			edge_id: event.edgeId,
			offset: event.offset,
		}));
		await this.sendRcon(`/sc train_path_manager.create_train_proxy('${json}')`);
	}

	async handleForwardClearTrainPath(event: messages.GridworldForwardClearTrainPath) {
		const json = lib.escapeString(JSON.stringify({ id: event.id }));
		await this.sendRcon(`/sc train_path_manager.clear_train_path_request('${json}')`);
	}

	async handleForwardTrainPath(event: messages.GridworldForwardTrainPath) {
		this.logger.info(`[gridworld] forward_train_path received: train=${event.id} destination=${event.destination} sourceInstance=${event.sourceInstanceId}`);
		const json = lib.escapeString(JSON.stringify({
			id: event.id,
			surface: event.surface,
			position: event.position,
			direction: event.direction,
			destination: event.destination,
			sourceInstanceId: event.sourceInstanceId,
		}));
		await this.sendRcon(`/sc train_path_manager.find_train_path('${json}')`);
	}
}
