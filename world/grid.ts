import type { EdgeSpec } from "universal_edges/edges";
import type { Tile, TileConfig, World } from "./contracts.js";

// Pure tile geometry (SP2 spec §5.1, §10.1, §12.1). Tile (x, y) covers [xT − T/2, xT + T/2) × [yT − T/2, yT + T/2),
// v1's convention; T/2 is a multiple of 32, so every chunk lies wholly inside or wholly outside a tile.

type Facing = 0 | 4 | 8 | 12;
type Frame = { origin: [number, number]; facing: Facing };

export function tileKey(x: number, y: number): string {
	return `${x},${y}`;
}

export function bounds(tileSize: number, x: number, y: number): [number, number, number, number] {
	const h = tileSize / 2;
	return [x * tileSize - h, y * tileSize - h, x * tileSize + h, y * tileSize + h];
}

/** The growth rule's 4 orthogonal neighbours (§6.2). */
export const NEIGHBOURS: [number, number][] = [[0, -1], [1, 0], [0, 1], [-1, 0]];

/** The tile each corner square lies in (§12.1): outside both borders at that corner. */
export const DIAGONALS = { ne: [1, -1], se: [1, 1], sw: [-1, 1], nw: [-1, -1] } as const;

/** rot(1, 0, facing) (SP1 spec §8): the direction side a's local x runs along the edge. */
const ALONG: Record<Facing, [number, number]> = { 0: [1, 0], 4: [0, 1], 8: [-1, 0], 12: [0, -1] };

/** SP1 spec §8's stitching check: b faces a, and b's origin is a's far end. */
export function coincident(a: Frame, b: Frame, length: number): boolean {
	const [dx, dy] = ALONG[a.facing];
	return b.facing === (a.facing + 8) % 16
		&& b.origin[0] === a.origin[0] + length * dx && b.origin[1] === a.origin[1] + length * dy;
}

/**
 * §10.1: the world id keeps a new world clear of the last one's tombstones; both instance ids do the same for a
 * replaced tile, whose new instance gives a new id. Surfaces spec §6: the base planet keeps SP2's id (A4); any other
 * planet's surface name goes after the world id. The last three segments never hold a ":", so distinct (planet, pair)
 * give distinct ids whatever a mod names its planet.
 */
export function edgeId(world: World, surface: string, a: Tile, b: Tile): string {
	const planet = surface === world.surface ? "" : `${surface}:`;
	return `gridworld:${world.id}:${planet}${a.x},${a.y}:${b.x},${b.y}:${a.instanceId},${b.instanceId}`;
}

/** The edge on surface between a and its east or south neighbour b (§10.1's table, in SP1's facing convention, D10). */
export function edgeSpec(world: World, surface: string, a: Tile, b: Tile): EdgeSpec {
	const vertical = b.x === a.x && b.y === a.y + 1;
	if (!vertical && !(b.x === a.x + 1 && b.y === a.y)) {
		throw new Error(`tile ${tileKey(a.x, a.y)} is not a north or west neighbour of ${tileKey(b.x, b.y)}`);
	}
	if (a.instanceId === undefined || b.instanceId === undefined) {
		throw new Error(`tiles ${tileKey(a.x, a.y)} and ${tileKey(b.x, b.y)} need instances for an edge`);
	}
	const T = world.tileSize;
	const h = T / 2;
	const fa: Frame = vertical
		? { origin: [a.x * T + h, a.y * T + h], facing: 8 }
		: { origin: [a.x * T + h, a.y * T - h], facing: 4 };
	const fb: Frame = vertical
		? { origin: [a.x * T - h, a.y * T + h], facing: 0 }
		: { origin: [a.x * T + h, a.y * T + h], facing: 12 };
	const id = edgeId(world, surface, a, b);
	// §10.1: the planner asserts SP1 §8's coincidence before every ensure.
	if (!coincident(fa, fb, T)) {
		throw new Error(`edge ${id} is not coincident`);
	}
	return {
		id,
		owner: "gridworld",
		length: T,
		a: { instanceId: a.instanceId, surface, ...fa },
		b: { instanceId: b.instanceId, surface, ...fb },
	};
}

/**
 * §10.1: the edges of each orthogonal pair whose instances both exist in Clusterio; side a is the north or west tile.
 * Surfaces spec §6 (W4): the base planet's edge, then one per other planet both tiles report. An excluded planet is
 * never reported, so no filter is needed here (§4.1).
 */
export function desiredEdges(world: World, exists: (instanceId: number) => boolean): EdgeSpec[] {
	const live = (t: Tile | undefined): t is Tile => t?.instanceId !== undefined && exists(t.instanceId);
	const specs: EdgeSpec[] = [];
	for (const a of Object.values(world.tiles)) {
		for (const [dx, dy] of [[1, 0], [0, 1]]) {
			const b = world.tiles[tileKey(a.x + dx, a.y + dy)];
			if (live(a) && live(b)) {
				const shared = (a.planets ?? []).filter(p => p !== world.surface && b.planets?.includes(p));
				for (const surface of [world.surface, ...shared]) {
					specs.push(edgeSpec(world, surface, a, b));
				}
			}
		}
	}
	return specs;
}

/** Tile t's gridworld.tile config (§5.2): its identity and trace, and the world's exclude list if any (§4.3). */
export function tileConfig(world: World, t: Tile): TileConfig {
	const { id, tileSize, surface, seed, exclude } = world;
	return {
		world: id, x: t.x, y: t.y, size: tileSize, surface, seed, trace: t.trace, ...(exclude ? { exclude } : {}),
	};
}

export function newTile(x: number, y: number, trace: string, nowMs: number): Tile {
	return { x, y, trace, createdAtMs: nowMs, updatedAtMs: nowMs };
}
