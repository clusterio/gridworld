import type { EvolutionPlanet } from "./contracts.js";

/** Cross-border biters spec §8: each planet's three parts as the controller keeps them, and vanilla's time factor. */
export type Parts = { time: number; pollution: number; kills: number };
export type Evolution = { planets: Record<string, Parts>; timeFactor: number };

export function newEvolution(): Evolution {
	return { planets: {}, timeFactor: 0.000004 };
}

/** Spec §8: a report adds each planet's growth; a planet the controller hasn't seen takes the reported time part. */
export function addReport(state: Evolution, planets: EvolutionPlanet[], timeFactor: number): void {
	state.timeFactor = timeFactor;
	for (const p of planets) {
		const cur = state.planets[p.surface];
		if (cur) {
			cur.pollution += p.pollution;
			cur.kills += p.kills;
		} else {
			state.planets[p.surface] = { time: p.time, pollution: p.pollution, kills: p.kills };
		}
	}
}

/** Spec §8: the time part advances once for the cluster, time_factor a second. */
export function advance(state: Evolution, seconds: number): void {
	for (const p of Object.values(state.planets)) {
		// Spike 34 E2: the parts grow undamped; only the total is damped, which S / (1 + S) already gives.
		p.time += state.timeFactor * seconds;
	}
}

/** The apply's planets: every planet's three parts. */
export function parts(state: Evolution): EvolutionPlanet[] {
	return Object.entries(state.planets).map(([surface, p]) => ({ surface, ...p }));
}
