import type { Anchor, PlanetDay } from "./contracts.js";

/** §11.1: canonical(t) = (epochDaytime + (t − epochMs) / msPerDay) mod 1, with msPerDay = ticksPerDay / 60 × 1000. */
export function canonical(anchor: Anchor, nowMs: number): number {
	const x = anchor.epochDaytime + (nowMs - anchor.epochMs) / (anchor.ticksPerDay / 60 * 1000);
	const d = x - Math.floor(x);
	return d < 1 ? d : 0; // a tiny negative x can round up to exactly 1
}

/** §11.1: the controller's clock seen from this host. The largest sentAtMs − now sample is the least delayed one. */
export class OffsetClock {
	private offset?: number;

	sample(sentAtMs: number, nowMs: number): void {
		const s = sentAtMs - nowMs;
		if (this.offset === undefined || s > this.offset) {
			this.offset = s;
		}
	}

	now(nowMs: number): number {
		return nowMs + (this.offset ?? 0);
	}
}

/** Surfaces spec §9.1: a planet's sync period in ticks, a quarter of its day and at most SP2's 60 s, so A ≤ 0.25. */
export function period(ticksPerDay: number): number {
	return Math.min(3600, Math.floor(ticksPerDay / 4));
}

/**
 * Surfaces spec §9.4: the planets this tile syncs, each with its day — those Lua reported with a day (W29), the base
 * planet at the anchor's (the world's ticksPerDay, D29). A planet Lua reported without a day isn't listed.
 */
export function synced(
	base: string, anchor: Anchor, reported: PlanetDay[],
): { surface: string; ticksPerDay: number }[] {
	return reported.flatMap(p => {
		if (p.ticksPerDay === undefined) {
			return [];
		}
		return [{ surface: p.surface, ticksPerDay: p.surface === base ? anchor.ticksPerDay : p.ticksPerDay }];
	});
}
