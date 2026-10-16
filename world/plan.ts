import { isDeepStrictEqual } from "node:util";
import type { EdgeRecord, EdgeSpec } from "universal_edges/edges";
import type { Tile, World } from "./contracts.js";
import { NEIGHBOURS, tileKey } from "./grid.js";

// The planner (SP2 spec §6.2, §10.2): pure functions from the world record and Clusterio's facts to record changes
// and actions. reconciler.ts gathers the facts, writes the changes, and only then runs the actions.

export type InstanceFact = {
	id: number;
	name: string;
	status: string;
	host: number | null;
	/** Its host lists a save other than *.tmp.zip, which a start naming no save would load (§6.2). */
	hasSave: boolean;
};

/** A host as the reconciler sees it (§7.1): no plugin filter, and no exclusion of a host about to shut down (D24). */
export type HostView = { id: number; connected: boolean; publicAddress: string };

/** What asked for a tile's start (§8): its birth, or a player's join next door. */
export type Trigger = "birth" | "join";

export type Facts = {
	nowMs: number;
	instances: Map<number, InstanceFact>;
	/** Every connected host the balancer accepts (balancer spec §8, memory amendment §3.6), sorted by id (§7.1). */
	hosts: number[];
	/** The tiles with a start wanted, by key (§8). */
	wanted: Map<string, Trigger>;
	/** Keys with an action in flight, and "i<id>" for each one's instance: nothing more is planned for them. */
	busy: Set<string>;
	/** Keys backing off after a failure, until then (§6.3). */
	retryAt: Map<string, number>;
	/** The round-robin counter (§7.1): the next assignment takes hosts[counter mod n]. */
	counter: number;
};

export type Action =
	| { kind: "create"; key: string }
	| { kind: "assign"; key: string; instanceId: number; host: number | null; name?: string }
	| { kind: "createSave"; key: string; instanceId: number; save: string }
	| { kind: "start"; key: string; instanceId: number; trigger: Trigger }
	| { kind: "stop" | "delete"; key: string; instanceId: number; name?: string };

export type Note = { tile: Tile; phase: string; level: "info" | "warn" | "error"; fields: Record<string, unknown> };

export type Plan = {
	/** Records to write before any action runs: a missing instance's tile, its instanceId cleared. */
	tiles: Tile[];
	counter: number;
	actions: Action[];
	/** gw.tile lines to log once the changes are written. */
	notes: Note[];
	/** Start wants that are met, skipped or sent this pass. */
	unwant: string[];
	/** A deleting world with no gridworld_* or pathworld instance left: its record can go (§14). */
	drop: boolean;
};

export function saveName(t: { x: number; y: number }): string {
	return `gridworld_${t.x}_${t.y}.zip`;
}

/** §7.1: every connected host, sorted by id, as v1 picked them (`gridworld/controller.ts:434-444`). */
export function connectedHosts(hosts: HostView[]): number[] {
	return hosts.filter(h => h.connected).map(h => h.id).sort((a, b) => a - b);
}

/** Deletion goes by name, as v1 (§14): every instance named gridworld_* or pathworld, whoever made it. */
export function deletedByName(name: string): boolean {
	return name.startsWith("gridworld_") || name === "pathworld";
}

/** §6.2 growth: the tile a player joined, its missing orthogonal neighbours to plan, and all 4 to start. */
export function growth(world: World | null, instanceId: number): { plan: [number, number][]; want: string[] } {
	const t = world && !world.deleting ? Object.values(world.tiles).find(x => x.instanceId === instanceId) : undefined;
	if (!world || !t) {
		return { plan: [], want: [] };
	}
	const around = NEIGHBOURS.map(([dx, dy]): [number, number] => [t.x + dx, t.y + dy]);
	return {
		plan: around.filter(([x, y]) => !world.tiles[tileKey(x, y)]),
		want: around.map(([x, y]) => tileKey(x, y)),
	};
}

/** One pass of §6.2 over the world record; pure. */
export function planTiles(world: World | null, f: Facts): Plan {
	const plan: Plan = { tiles: [], counter: f.counter, actions: [], notes: [], unwant: [], drop: false };
	const blocked = (key: string) => f.busy.has(key) || (f.retryAt.get(key) ?? 0) > f.nowMs;
	if (world?.deleting) {
		let remaining = 0;
		for (const inst of f.instances.values()) {
			if (deletedByName(inst.name)) {
				remaining += 1;
				if (!blocked(`i${inst.id}`)) {
					sweep(plan, inst);
				}
			}
		}
		// An action in flight may still create or keep an instance; the record goes only once all have settled.
		plan.drop = remaining === 0 && f.busy.size === 0;
	} else if (world) {
		for (const t of Object.values(world.tiles)) {
			if (!blocked(tileKey(t.x, t.y))) {
				planTile(plan, f, t);
			}
		}
	}
	return plan;
}

/** §6.2's rows for one tile of a live world; the first that matches applies. */
function planTile(plan: Plan, f: Facts, t: Tile): void {
	const key = tileKey(t.x, t.y);
	if (t.instanceId === undefined) {
		plan.actions.push({ kind: "create", key });
		return;
	}
	const trigger = f.wanted.get(key);
	if (!trigger) {
		return; // GW never restarts a tile (§8)
	}
	const inst = f.instances.get(t.instanceId);
	if (!inst) {
		// §6.2 Missing: the want stays, and a new instance is created once the cleared record is written.
		const replanned = { ...t, instanceId: undefined };
		plan.tiles.push(replanned);
		plan.actions.push({ kind: "create", key });
		const fields = { instance: t.instanceId };
		plan.notes.push({ tile: replanned, phase: "instance_missing", level: "error", fields });
		plan.notes.push({ tile: replanned, phase: "planned", level: "info", fields: { reason: "missing" } });
		return;
	}
	if (inst.status === "starting" || inst.status === "running") {
		plan.unwant.push(key);
	} else if (inst.host === null) {
		if (f.hosts.length === 0) {
			skip(plan, t, "no_hosts");
			return;
		}
		const host = f.hosts[plan.counter % f.hosts.length];
		plan.counter += 1;
		plan.actions.push({ kind: "assign", key, instanceId: inst.id, host });
	} else if (inst.status === "unknown") {
		skip(plan, t, "host_offline");
	} else if (inst.status === "stopped" && !inst.hasSave) {
		plan.actions.push({ kind: "createSave", key, instanceId: inst.id, save: saveName(t) });
	} else if (inst.status === "stopped") {
		plan.actions.push({ kind: "start", key, instanceId: inst.id, trigger });
		plan.unwant.push(key);
	}
	// Stopping, creating a save, exporting data, or a status the host hasn't reported yet: the want waits.
}

/** §8 preconditions: a start that can't happen now is dropped and logged; the next join next door tries again. */
function skip(plan: Plan, t: Tile, reason: "no_hosts" | "host_offline"): void {
	plan.unwant.push(tileKey(t.x, t.y));
	plan.notes.push({ tile: t, phase: "start_skipped", level: "warn", fields: { instance: t.instanceId, reason } });
}

/** §14 via §6.2's stop-and-delete rules: stop, then delete; an instance on an offline host is unassigned first. */
function sweep(plan: Plan, inst: InstanceFact): void {
	const key = `i${inst.id}`;
	const { name } = inst;
	if (inst.status === "running" || inst.status === "starting") {
		plan.actions.push({ kind: "stop", key, instanceId: inst.id, name });
	} else if (inst.host === null || inst.status === "stopped") {
		plan.actions.push({ kind: "delete", key, instanceId: inst.id, name });
	} else if (inst.status === "unknown") {
		plan.actions.push({ kind: "assign", key, instanceId: inst.id, host: null, name });
	}
}

/** §10.2: what to ensure and remove so UE's gridworld edges match the desired set. A tombstone waits for purged. */
export function planEdges(
	desired: EdgeSpec[], actual: EdgeRecord[],
): { ensure: EdgeSpec[]; remove: string[]; rejected: string[] } {
	const ours = actual.filter(r => r.owner === "gridworld");
	const byId = new Map(ours.map(r => [r.id, r]));
	const wanted = new Set(desired.map(s => s.id));
	const ensure: EdgeSpec[] = [];
	const rejected: string[] = [];
	for (const s of desired) {
		const r = byId.get(s.id);
		if (!r) {
			ensure.push(s);
		} else if (!r.deleted && !isDeepStrictEqual([r.owner, r.length, r.a, r.b], [s.owner, s.length, s.a, s.b])) {
			rejected.push(s.id);
		}
	}
	const remove = ours.filter(r => !r.deleted && !wanted.has(r.id)).map(r => r.id);
	return { ensure, remove, rejected };
}
