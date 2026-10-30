import type * as lib from "@clusterio/lib";
import { setEdgeApi, type EdgeApi, type EdgeEvent, type EdgeRecord } from "universal_edges/edges";
import type { BalancerApi } from "../../world/balancer.js";
import type { TileConfig, Toggles } from "../../world/contracts.js";
import type { HostView } from "../../world/plan.js";
import { Reconciler, type InstanceView, type Port } from "../../world/reconciler.js";
import { WorldStore, fileData } from "../../world/store.js";

// Shared by the unit tests. Compiled beside them; the unit runner only runs *.test.js files.

export type Line = { level: string; message: string; meta: Record<string, any> };

/** A logger that records every line: lifecycle() calls log(level, …), and rateLimited() calls warn(…). */
export function fakeLogger(lines: Line[] = []): lib.Logger {
	const log = (level: string, message: string, meta: Record<string, any> = {}) => {
		lines.push({ level, message, meta });
	};
	return {
		log,
		error: (message: string, meta?: Record<string, any>) => log("error", message, meta),
		warn: (message: string, meta?: Record<string, any>) => log("warn", message, meta),
		info: (message: string, meta?: Record<string, any>) => log("info", message, meta),
		verbose: (message: string, meta?: Record<string, any>) => log("verbose", message, meta),
	} as unknown as lib.Logger;
}

/** Let setImmediate callbacks, and the promises they start, run for a few turns. */
export async function settle(turns = 20): Promise<void> {
	for (let i = 0; i < turns; i++) {
		await new Promise(resolve => {
			setImmediate(resolve);
		});
	}
}

/**
 * A fake Clusterio: instances and hosts a test edits, and every call the reconciler made. An assignment leaves the
 * instance stopped, a save creation lists the save, and a start runs it; failing(name) makes that call throw.
 */
export function fakeCluster() {
	const instances = new Map<number, InstanceView>();
	const hosts: HostView[] = [
		{ id: 1, connected: true, publicAddress: "10.0.0.1" },
		{ id: 2, connected: true, publicAddress: "10.0.0.2" },
	];
	const calls: string[] = [];
	const sent: { to: number; event: object }[] = [];
	const toggles: Toggles = {
		pollution_border: true, cross_border_raids: true, cross_border_expansion: true, shared_evolution: true,
	};
	const failing = new Set<string>();
	let nextId = 101;
	let saveData = async () => undefined;
	const call = (text: string) => {
		calls.push(text);
		const name = text.split(" ")[0];
		if (failing.has(name)) {
			throw new Error(`${name} failed`);
		}
	};
	/** The balancer API the port hands out; undefined stands for a cluster without the balancer plugin. */
	const balancerSlot: { api?: BalancerApi } = {};
	const port: Port = {
		instances: () => [...instances.values()],
		hosts: () => hosts,
		createInstance: async (name: string, config: TileConfig) => {
			const id = nextId;
			nextId += 1;
			call(`create ${id} ${config.x},${config.y}`);
			instances.set(id, { id, name, status: "unassigned", host: null, hasSave: false });
			return id;
		},
		assign: async (id: number, host: number | null) => {
			call(`assign ${id} ${host}`);
			const i = instances.get(id)!;
			i.host = host;
			i.status = host === null ? "unassigned" : "stopped";
		},
		createSave: async (id: number, save: string) => {
			call(`createSave ${id} ${save}`);
			instances.get(id)!.hasSave = true;
		},
		start: async (id: number) => {
			call(`start ${id}`);
			instances.get(id)!.status = "running";
		},
		stop: async (id: number) => {
			call(`stop ${id}`);
			instances.get(id)!.status = "stopped";
		},
		remove: async (id: number) => {
			call(`delete ${id}`);
			instances.delete(id);
		},
		saveData: () => {
			calls.push("saveData");
			return saveData();
		},
		send: (to: number, event: object) => {
			sent.push({ to, event });
		},
		toggles: () => ({ ...toggles }),
		balancerApi: () => {
			if (!balancerSlot.api) {
				throw new Error("balancer: the API is not ready; is the balancer plugin loaded?");
			}
			return balancerSlot.api;
		},
	};
	/** From now on, saveData() waits until the returned function is called. */
	function gateSaveData(): () => void {
		let release!: () => void;
		const gate = new Promise<undefined>(resolve => {
			release = () => resolve(undefined);
		});
		saveData = () => gate;
		return release;
	}
	return { instances, hosts, calls, sent, toggles, failing, port, gateSaveData, balancerSlot };
}

/** A fake of UE's edge API: ensure and remove write at once; emit() plays UE's events to the listeners. */
export function fakeEdges() {
	const records = new Map<string, EdgeRecord>();
	const listeners = new Set<(event: EdgeEvent) => void>();
	const api: EdgeApi = {
		ensure: async spec => {
			const r = { ...spec, revision: 1, deleted: false, connectors: [], trace: `ue.${spec.id}`, updatedAtMs: 0 };
			records.set(spec.id, r);
			return r;
		},
		remove: async id => {
			const r = records.get(id);
			if (r) {
				r.deleted = true;
			}
		},
		get: id => records.get(id),
		list: filter => [...records.values()].filter(r => filter?.owner === undefined || r.owner === filter.owner),
		isActive: () => false,
		on: listener => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	};
	const emit = (event: EdgeEvent) => {
		for (const listener of listeners) {
			listener(event);
		}
	};
	return { api, records, emit };
}

/**
 * A fake of the balancer's API (balancer spec §4.5): `moving` holds the instances it moves, `refused` the hosts it
 * doesn't accept (draining, or no memory room: memory amendment §3.6); finish() ends a move.
 */
export function fakeBalancer() {
	const moving = new Set<number>();
	const refused = new Set<number>();
	const listeners = new Set<(instanceId: number) => void>();
	const api: BalancerApi = {
		moving: id => moving.has(id),
		accepts: id => !refused.has(id),
		onMoveFinished: listener => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	};
	const finish = (id: number) => {
		for (const listener of listeners) {
			listener(id);
		}
	};
	return { api, moving, refused, finish };
}

/** A reconciler over a fresh store, the fake cluster and the fake edge API, logging into `lines`. */
export function setup(now?: () => number) {
	const lines: Line[] = [];
	const cluster = fakeCluster();
	const disk: unknown[] = [];
	const store = new WorldStore(fileData(undefined), {
		save: async data => {
			disk.push(structuredClone(data));
		},
		published: () => undefined,
	}, fakeLogger(lines), now);
	const edges = fakeEdges();
	setEdgeApi(edges.api);
	const balancer = fakeBalancer();
	cluster.balancerSlot.api = balancer.api;
	const reconciler = new Reconciler(store, cluster.port, fakeLogger(lines), now);
	return { lines, cluster, store, disk, edges, balancer, reconciler };
}

/** The phases logged for op, in order. */
export function phases(lines: Line[], op: string): string[] {
	return lines.filter(l => l.meta.op === op).map(l => String(l.meta.phase));
}
