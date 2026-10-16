import { performance } from "node:perf_hooks";
import type { World } from "../../world/contracts.js";
import { desiredEdges, newTile, tileKey } from "../../world/grid.js";
import { planEdges, planTiles, type Facts, type InstanceFact } from "../../world/plan.js";

// SP2 spec §15: planTiles over a steady world of n running tiles, each with a start wanted (the worst case: every
// row down to the status check runs), nothing to do. Prints markdown rows for docs/perf/<date>-sp2-tile.md:
// | tiles | median ms | max ms |, over 21 runs.

function steady(n: number): { world: World; facts: Facts } {
	const world: World = {
		id: "bench", trace: "bench.t", createdAtMs: 0, tileSize: 512, surface: "nauvis", seed: 1, ticksPerDay: 25000,
		epochMs: 0, epochDaytime: 0, deleting: false, tiles: {},
	};
	const instances = new Map<number, InstanceFact>();
	const wanted: Facts["wanted"] = new Map();
	const side = Math.ceil(Math.sqrt(n));
	for (let i = 0; i < n; i++) {
		const x = i % side;
		const y = Math.floor(i / side);
		world.tiles[tileKey(x, y)] = { ...newTile(x, y, `t${i}`, 0), instanceId: i + 1 };
		const name = `gridworld_${x}_${y}`;
		instances.set(i + 1, { id: i + 1, name, status: "running", host: 1 + (i % 4), hasSave: true });
		wanted.set(tileKey(x, y), "join");
	}
	const facts: Facts = {
		nowMs: 1, instances, hosts: [1, 2, 3, 4], wanted, busy: new Set(), retryAt: new Map(), counter: 0,
	};
	return { world, facts };
}

for (const n of [1000, 10000]) {
	const { world, facts } = steady(n);
	const ms: number[] = [];
	for (let run = 0; run < 21; run++) {
		const start = performance.now();
		planTiles(world, facts);
		ms.push(performance.now() - start);
	}
	ms.sort((a, b) => a - b);
	process.stdout.write(`| ${n} | ${ms[10].toFixed(2)} | ${ms[20].toFixed(2)} |\n`);
}

// Surfaces plan Task 3 (spec §17 risk 10): the edge plan with Space Age's five planets reported on every tile, against
// UE records that already hold every edge (a pass after something changed).
// | edges, tiles × planets | median ms | max ms |.
const FIVE = ["aquilo", "fulgora", "gleba", "nauvis", "vulcanus"];
for (const n of [1000, 10000]) {
	const { world, facts } = steady(n);
	for (const t of Object.values(world.tiles)) {
		t.planets = FIVE;
	}
	const exists = (id: number) => facts.instances.has(id);
	const records = desiredEdges(world, exists).map(s => ({
		...s, revision: 1, deleted: false, connectors: [], trace: "bench", updatedAtMs: 0,
	}));
	const ms: number[] = [];
	for (let run = 0; run < 21; run++) {
		const start = performance.now();
		planEdges(desiredEdges(world, exists), records);
		ms.push(performance.now() - start);
	}
	ms.sort((a, b) => a - b);
	process.stdout.write(
		`| edges, ${n} tiles × 5 planets (${records.length}) | ${ms[10].toFixed(2)} | ${ms[20].toFixed(2)} |\n`,
	);
}
