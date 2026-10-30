import * as path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * The balancer's in-process API (balancer/api.ts, balancer spec §4.5). A copy of its interface, so that gridworld
 * builds without the balancer; harness/test/balancer_contract.ts fails the monorepo's type check if they drift.
 */
export interface BalancerApi {
	/** A move of this instance is queued or in progress: gridworld neither starts, stops nor assigns it (§8). */
	moving(instanceId: number): boolean;
	/**
	 * Gridworld may place a new tile on the host: it isn't draining (§5.4), and a new tile's need fits its room (memory
	 * amendment §3.6). Gridworld's round-robin skips the others (§8).
	 */
	accepts(hostId: number): boolean;
	/** Runs after each move ends, done or failed; returns the unsubscribe. */
	onMoveFinished(listener: (instanceId: number) => void): () => void;
}

/**
 * The balancer's balancerApi(), imported from the file Clusterio's loader imports (its plugin list entry), so both
 * share its singleton, as the minimap finds UE's (minimap/integrations.ts). Undefined without the balancer in the
 * plugin list, or when its build won't import.
 */
export async function loadBalancerApi(
	infos: { name: string; requirePath: string }[],
	onError?: (err: unknown) => void,
): Promise<(() => BalancerApi) | undefined> {
	const info = infos.find(p => p.name === "balancer");
	if (!info) {
		return undefined;
	}
	try {
		const mod = await import(pathToFileURL(path.posix.join(info.requirePath, "dist/node/api.js")).href);
		return mod.balancerApi as () => BalancerApi;
	} catch (err) {
		onError?.(err);
		return undefined;
	}
}
