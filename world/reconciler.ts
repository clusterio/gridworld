import { isDeepStrictEqual } from "node:util";
import type * as lib from "@clusterio/lib";
import { edgeApi, type EdgeApi } from "universal_edges/edges";
import type { BalancerApi } from "./balancer.js";
import { lifecycle, rateLimited } from "universal_edges/runtime";
import {
	DaytimeAnchorEvent, TogglesEvent, type Tile, type TileConfig, type TileStatus, type Toggles, type World,
} from "./contracts.js";
import { DIAGONALS, desiredEdges, tileConfig, tileKey } from "./grid.js";
import {
	connectedHosts, growth, planEdges, planTiles, type Action, type Facts, type HostView, type InstanceFact,
	type Trigger,
} from "./plan.js";
import type { CreateOptions, WorldStore } from "./store.js";

export type InstanceView = InstanceFact & { gamePort?: number };
/** What instanceStatusChanged tells the reconciler about an instance. */
export type StatusView = { id: number; status: string };

/** What the reconciler needs from Clusterio: controller.ts implements it over the controller, the tests fake it. */
export type Port = {
	instances(): InstanceView[];
	hosts(): HostView[];
	createInstance(name: string, config: TileConfig): Promise<number>;
	assign(instanceId: number, host: number | null): Promise<void>;
	createSave(instanceId: number, save: string, world: World): Promise<void>;
	/** A start naming no save: the host loads its newest (§8). */
	start(instanceId: number): Promise<void>;
	stop(instanceId: number): Promise<void>;
	remove(instanceId: number): Promise<void>;
	/** controller.saveData(): Clusterio's own records reach disk (§5.1). */
	saveData(): Promise<void>;
	send(instanceId: number, event: object): void;
	/** The biter toggles, as the controller config holds them now. */
	toggles(): Toggles;
	/** The balancer's API (balancer spec §4.5); throws while the balancer isn't loaded or hasn't set it. */
	balancerApi(): BalancerApi;
};

/** The tile whose instance this is. ponytail: an O(tiles) scan per event; index it if passes show up in profiles. */
function tileOf(world: World, instanceId: number): Tile | undefined {
	return Object.values(world.tiles).find(t => t.instanceId === instanceId);
}

/** The steps of a start (§6.3): when one fails, the want goes, and nothing retries it before the next join. */
function startStep(a: Action): boolean {
	return a.kind === "createSave" || a.kind === "start" || (a.kind === "assign" && !a.key.startsWith("i"));
}

/**
 * The reconciler (SP2 spec §6.3): passes gather facts, run plan.ts, write the record, and only then act. Actions run
 * asynchronously, one per tile. The start wants and the round-robin counter live here, in memory, as v1's did.
 */
export class Reconciler {
	private wants = new Map<string, Trigger>();
	private counter = 0;
	private inflight = new Map<string, Action>();
	private failures = new Map<string, { count: number; retryAt: number }>();
	private dirty = false;
	private looping = false;
	private edgeOps = new Set<string>();
	/** What the last edge plan saw, so a steady pass skips UE's list and planEdges (O(edges) each). */
	private edgesKey?: string;
	private edgesDirty = false;
	private listening = false;
	private warn: ReturnType<typeof rateLimited>;
	/** The balancer's hand-off (balancer spec §8): warned once when it's missing; subscribed once it's found. */
	private balancerWarned = false;
	private balancerListening = false;

	constructor(
		private store: WorldStore,
		private port: Port,
		private logger: lib.Logger,
		private now: () => number = Date.now,
	) {
		this.warn = rateLimited(logger);
	}

	/** §6.3 triggers: all of one event-loop turn make one pass, and passes run one at a time. */
	trigger(): void {
		this.dirty = true;
		if (!this.looping) {
			this.looping = true;
			setImmediate(() => {
				void this.loop();
			});
		}
	}

	private async loop(): Promise<void> {
		while (this.dirty) {
			this.dirty = false;
			try {
				await this.pass();
			} catch (err: any) {
				this.logger.error(`gw.tile pass failed: ${err.stack ?? err.message}`);
			}
		}
		this.looping = false;
	}

	private async pass(): Promise<void> {
		const world = this.store.world;
		if (world?.deleting) {
			this.wants.clear(); // §6.2: a deleting world has no tile rows, and its start wants go
		}
		const f = this.facts();
		const plan = planTiles(world, f);
		this.counter = plan.counter;
		for (const tile of plan.tiles) {
			this.store.put(tile);
		}
		// §5.1 persist, then act: nothing below runs until every change so far is written, this pass's included.
		if (plan.drop) {
			await this.store.dropWorld();
		} else {
			await this.store.save();
		}
		for (const key of plan.unwant) {
			this.wants.delete(key);
		}
		for (const n of plan.notes) {
			const fields = { x: n.tile.x, y: n.tile.y, ...n.fields, trace: n.tile.trace };
			lifecycle(this.logger, "gw.tile", n.phase, fields, n.level);
		}
		for (const a of plan.actions) {
			this.run(a);
		}
		this.edges(f);
	}

	private facts(): Facts {
		const busy = new Set<string>();
		for (const [key, a] of this.inflight) {
			busy.add(key);
			if (a.kind !== "create") {
				busy.add(`i${a.instanceId}`);
			}
		}
		// Balancer spec §8: no start, stop, assign or delete for an instance the balancer is moving.
		const balancer = this.balancer();
		for (const t of Object.values(this.store.world?.tiles ?? {})) {
			if (balancer && t.instanceId !== undefined && balancer.moving(t.instanceId)) {
				busy.add(tileKey(t.x, t.y));
				busy.add(`i${t.instanceId}`);
			}
		}
		return {
			nowMs: this.now(),
			instances: new Map(this.port.instances().map(i => [i.id, i])),
			// Balancer spec §8, memory amendment §3.6: the round-robin takes only the hosts the balancer accepts (not
			// draining, with room for a new tile). Gridworld holds no memory rule.
			hosts: connectedHosts(this.port.hosts()).filter(h => balancer?.accepts(h) ?? true),
			wanted: this.wants,
			busy,
			retryAt: new Map([...this.failures].map(([key, v]) => [key, v.retryAt])),
			counter: this.counter,
		};
	}

	/**
	 * The balancer's API (balancer spec §4.5), or undefined without the balancer: gridworld then plans as before, after
	 * one warning (the edgeApi pattern). A move's end runs a pass, which picks up any start wanted meanwhile.
	 */
	private balancer(): BalancerApi | undefined {
		let api: BalancerApi;
		try {
			api = this.port.balancerApi();
		} catch (err: any) {
			if (!this.balancerWarned) {
				this.balancerWarned = true;
				this.logger.warn("gw.balancer the balancer API is unavailable: moves are not held off", {
					error: err.message,
				});
			}
			return undefined;
		}
		if (!this.balancerListening) {
			this.balancerListening = true;
			api.onMoveFinished(() => this.trigger());
		}
		return api;
	}

	private run(a: Action): void {
		this.inflight.set(a.key, a);
		this.execute(a).then(() => {
			this.failures.delete(a.key);
		}, (err: Error) => {
			this.fail(a, err.message);
		}).finally(() => {
			this.inflight.delete(a.key);
			this.trigger();
		});
	}

	private async execute(a: Action): Promise<void> {
		if (a.kind === "create") {
			await this.create(a.key);
		} else if (a.kind === "assign") {
			await this.port.assign(a.instanceId, a.host);
			this.note(a.key, "placed", { instance: a.instanceId, host: a.host });
			this.swept(a, "instance_unassigned");
		} else if (a.kind === "createSave") {
			const world = this.store.world;
			if (world) {
				await this.port.createSave(a.instanceId, a.save, world);
				this.note(a.key, "save_created", { instance: a.instanceId, save: a.save });
			}
		} else if (a.kind === "start") {
			this.note(a.key, "starting", { instance: a.instanceId, reason: a.trigger });
			await this.port.start(a.instanceId);
		} else if (a.kind === "stop") {
			await this.port.stop(a.instanceId);
			this.swept(a, "instance_stopped");
		} else {
			await this.port.remove(a.instanceId);
			this.swept(a, "instance_deleted");
		}
	}

	/** §14: a deletion's sweep logs every instance it takes, by id and name, under the world's trace. */
	private swept(a: Action & { instanceId: number; name?: string }, phase: string): void {
		if (a.key.startsWith("i")) {
			const fields = { instance: a.instanceId, name: a.name, trace: this.store.world?.trace };
			lifecycle(this.logger, "gw.world", phase, fields);
		}
	}

	/**
	 * §6.2: create the tile's instance once its planned record is on disk, wait for Clusterio's record to reach disk,
	 * then persist the id (§5.1). The new instance's birth wants a start, unless a join already wants one.
	 */
	private async create(key: string): Promise<void> {
		const world = this.store.world;
		const t = world?.tiles[key];
		if (!world || world.deleting || !t || t.instanceId !== undefined) {
			return;
		}
		await this.store.save();
		if (this.store.world !== world || world.deleting) {
			return;
		}
		const id = await this.port.createInstance(`gridworld_${t.x}_${t.y}`, tileConfig(world, t));
		await this.port.saveData();
		if (this.store.world !== world || world.deleting) {
			return; // the world went meanwhile: its deletion takes the new instance by its name (§14)
		}
		t.instanceId = id;
		this.store.touch(t);
		this.wants.set(key, this.wants.get(key) ?? "birth");
		await this.store.save();
		lifecycle(this.logger, "gw.tile", "instance_created", { x: t.x, y: t.y, instance: id, trace: t.trace });
	}

	/** A gw.tile line for a tile key; a deletion's "i<id>" keys name no tile and log nothing here. */
	private note(key: string, phase: string, fields: Record<string, unknown>): void {
		const t = this.store.world?.tiles[key];
		if (t) {
			lifecycle(this.logger, "gw.tile", phase, { x: t.x, y: t.y, ...fields, trace: t.trace });
		}
	}

	/**
	 * §6.3: a failed step of a start drops its want, as v1 gave up on a failed start; any other failed action backs
	 * its key off, 10 s doubling to 10 minutes, and schedules the pass that retries it (Planning ruling 12).
	 */
	private fail(a: Action, error: string): void {
		const t = this.store.world?.tiles[a.key];
		const name = "name" in a ? a.name : undefined;
		const fields = {
			op: "gw.tile", phase: "action_failed", x: t?.x, y: t?.y, key: a.key, name, action: a.kind, error,
		};
		if (startStep(a)) {
			this.wants.delete(a.key);
			this.warn(`${a.key}:${a.kind}`, "gw.tile action_failed", { ...fields, trace: t?.trace });
			return;
		}
		const count = (this.failures.get(a.key)?.count ?? 0) + 1;
		const delay = Math.min(10_000 * 2 ** (count - 1), 600_000);
		this.failures.set(a.key, { count, retryAt: this.now() + delay });
		this.warn(`${a.key}:${a.kind}`, "gw.tile action_failed", { ...fields, failures: count, trace: t?.trace });
		setTimeout(() => this.trigger(), delay).unref();
	}

	/** §10.2: UE's gridworld edges follow the tiles; a deleting world leaves them to UE's instance tombstones. */
	private edges(f: Facts): void {
		let api: EdgeApi;
		try {
			api = edgeApi();
		} catch (err: any) {
			this.warn("edge_api", "gw.edge the universal_edges edge API is unavailable", { error: err.message });
			return;
		}
		if (!this.listening) {
			this.listening = true;
			api.on(event => {
				if (event.kind === "purged" && event.id.startsWith("gridworld:")) {
					this.edgesDirty = true;
					this.trigger();
				}
			});
		}
		const world = this.store.world;
		if (world?.deleting) {
			return;
		}
		// The desired set depends only on the tiles and which of their instances exist; UE's side changes under us
		// only by a purge or a failed op, which set edgesDirty. ponytail: the live count is O(tiles), far below a plan.
		const live = world
			? Object.values(world.tiles).filter(t => t.instanceId !== undefined && f.instances.has(t.instanceId)).length
			: 0;
		const key = `${world?.id}|${this.store.stamp}|${live}`;
		if (key === this.edgesKey && !this.edgesDirty) {
			return;
		}
		this.edgesKey = key;
		this.edgesDirty = false;
		const desired = world ? desiredEdges(world, id => f.instances.has(id)) : [];
		const plan = planEdges(desired, api.list({ owner: "gridworld" }));
		const trace = world?.trace;
		for (const spec of plan.ensure.filter(s => !this.edgeOps.has(s.id))) {
			this.edgeOp(spec.id, api.ensure(spec).then(r => {
				const fields = { edge: spec.id, reason: "both_instances", ueTrace: r.trace, trace };
				lifecycle(this.logger, "gw.edge", "ensured", fields);
			}));
		}
		for (const id of plan.remove.filter(r => !this.edgeOps.has(r))) {
			this.edgeOp(id, api.remove(id, "gridworld").then(() => {
				const fields = { edge: id, reason: "not_desired", ueTrace: api.get(id)?.trace, trace };
				lifecycle(this.logger, "gw.edge", "removed", fields);
			}));
		}
		for (const id of plan.rejected) {
			this.edgeFailed(id, new Error("a live edge with this id has another spec"));
		}
	}

	private edgeOp(id: string, op: Promise<void>): void {
		this.edgeOps.add(id);
		op.catch((err: Error & { code?: string }) => this.edgeFailed(id, err)).finally(() => {
			this.edgeOps.delete(id);
		});
	}

	private edgeFailed(id: string, err: Error & { code?: string }): void {
		this.edgesDirty = true; // the next pass plans again, as every pass did before the edge plan was skipped
		// The id's tombstone isn't purged yet (SP1 §5.1); UE's purged event brings the pass that ensures it.
		if (err.code !== "EdgeDeleting") {
			const fields = { op: "gw.edge", phase: "rejected", edge: id, error: err.message };
			this.warn(`edge:${id}`, "gw.edge rejected", fields);
		}
	}

	/** instanceStatusChanged: every change triggers a pass; a tile reaching running is logged. */
	async onStatus(instance: StatusView): Promise<void> {
		const world = this.store.world;
		const t = world && !world.deleting ? tileOf(world, instance.id) : undefined;
		if (t && world && instance.status === "running") {
			// §11.1: every start gets the anchor, unknown → running after a controller restart included; and the
			// biter toggles.
			this.anchor(world, instance.id);
			this.toggles(instance.id);
			lifecycle(this.logger, "gw.tile", "running", { x: t.x, y: t.y, instance: instance.id, trace: t.trace });
		}
		this.trigger();
	}

	/** §11.1: the frozen anchor, stamped with the controller's clock. */
	private anchor(world: World, instanceId: number): void {
		try {
			const { epochMs, epochDaytime, ticksPerDay } = world;
			this.port.send(instanceId, new DaytimeAnchorEvent(epochMs, epochDaytime, ticksPerDay, this.now()));
		} catch (err: any) {
			const fields = { instance: instanceId, error: err.message };
			this.warn(`anchor:${instanceId}`, "gw.time anchor not delivered", fields);
		}
	}

	/** The instance ids of the running tiles. */
	private runningTiles(): number[] {
		const world = this.store.world;
		if (!world || world.deleting) {
			return [];
		}
		const running = new Set(this.port.instances().filter(i => i.status === "running").map(i => i.id));
		return Object.values(world.tiles).flatMap(t => (t.instanceId !== undefined && running.has(t.instanceId)
			? [t.instanceId]
			: []));
	}

	/**
	 * §11.1, hourly: every running tile gets the anchor again, so one lost anchor costs at most an hour; and the biter
	 * toggles, for the same reason.
	 */
	broadcastAnchors(): void {
		for (const id of this.runningTiles()) {
			this.anchor(this.store.world!, id);
			this.toggles(id);
		}
	}

	/** The biter toggles (owner, 2026-10-10); the instance passes them to Lua in gw.tile.config. */
	private toggles(instanceId: number): void {
		try {
			this.port.send(instanceId, new TogglesEvent(this.port.toggles()));
		} catch (err: any) {
			const fields = { instance: instanceId, error: err.message };
			this.warn(`toggles:${instanceId}`, "gw.toggles not delivered", fields);
		}
	}

	/**
	 * controllerConfigFieldChanged: a toggle's change goes to every running tile at once, so it lands within seconds.
	 * ponytail: every gridworld.* controller field is a toggle; a field that isn't would only re-send them, harmlessly.
	 */
	onControllerConfig(field: string): void {
		if (field.startsWith("gridworld.")) {
			for (const id of this.runningTiles()) {
				this.toggles(id);
			}
		}
	}

	/** Player-crossing spec §7.2: the instance of the tile diagonal to from's at the key's corner, or why not. */
	crossing(from: number, key: string): number | string {
		const corner = key.slice("gridworld:".length);
		if (!Object.hasOwn(DIAGONALS, corner)) {
			return "unknown_corner";
		}
		const target = this.diagonal(from, corner as keyof typeof DIAGONALS);
		return typeof target === "string" ? target : target.id;
	}

	/** The instance of the tile diagonal to from's tile at corner (§12.1), or why there is none. */
	private diagonal(from: number, corner: keyof typeof DIAGONALS): InstanceView | string {
		const world = this.store.world;
		const a = world && !world.deleting ? tileOf(world, from) : undefined;
		if (!world || !a) {
			return world ? "not_a_tile" : "no_world";
		}
		const [dx, dy] = DIAGONALS[corner];
		const id = world.tiles[tileKey(a.x + dx, a.y + dy)]?.instanceId;
		return this.port.instances().find(i => i.id === id) ?? "no_tile";
	}

	/** §6.2 growth: a join plans the joined tile's missing neighbours and wants all 4 started. */
	async onPlayerJoin(instanceId: number): Promise<void> {
		const { plan, want } = growth(this.store.world, instanceId);
		for (const key of want) {
			this.wants.set(key, this.wants.get(key) ?? "join");
		}
		try {
			for (const [x, y] of plan) {
				await this.store.createTile(x, y, "join");
			}
		} finally {
			this.trigger();
		}
	}

	/**
	 * Surfaces spec §4.1 (W25): a tile's reported planets, stored sorted when they changed. Persist, then act: the
	 * write, the gw.tile planets line, then the pass that agrees the pairs' edges (§6). A repeat changes nothing and
	 * logs nothing; a sender that is no tile is ignored.
	 */
	async onPlanets(instanceId: number, planets: string[]): Promise<void> {
		const world = this.store.world;
		const t = world && !world.deleting ? tileOf(world, instanceId) : undefined;
		const sorted = [...planets].sort();
		if (!t || isDeepStrictEqual(sorted, t.planets)) {
			return;
		}
		t.planets = sorted;
		this.store.touch(t);
		await this.store.save();
		lifecycle(this.logger, "gw.tile", "planets", {
			x: t.x, y: t.y, instance: instanceId, planets: sorted, trace: t.trace,
		});
		this.trigger();
	}

	async createWorld(opts: CreateOptions): Promise<void> {
		await this.store.createWorld(opts);
		this.trigger();
	}

	async deleteWorld(): Promise<void> {
		await this.store.deleteWorld();
		this.trigger();
	}

	async createTile(x: number, y: number): Promise<void> {
		await this.store.createTile(x, y, "tile_create");
		this.trigger();
	}

	/** world show (§13): each tile's record, and its instance's status and assigned host from Clusterio. */
	statuses(): TileStatus[] {
		const views = new Map(this.port.instances().map(i => [i.id, i]));
		return Object.values(this.store.world?.tiles ?? {}).map(t => {
			const v = t.instanceId === undefined ? undefined : views.get(t.instanceId);
			const host = v?.host ?? undefined;
			return {
				x: t.x, y: t.y, instanceId: t.instanceId, host, status: v?.status, trace: t.trace,
				...(t.planets ? { planets: t.planets } : {}),
			};
		});
	}
}
