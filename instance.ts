import type { InstancePluginContext } from "@clusterio/host";
import { on, openBridge } from "universal_edges/runtime";
import {
	DaytimeAnchorEvent, EvolutionApplyEvent, EvolutionReportEvent, EvolutionReportPayload, TilePlanetsEvent,
	TilePlanetsPayload, TogglesEvent, type Anchor, type PlanetDay, type Toggles,
} from "./world/contracts.js";
import { OffsetClock, canonical, period, synced } from "./world/time.js";

/** §7.3: the tile config goes to Lua at every start and once a minute; Lua answers each with its planets (§4.1). */
const CONFIG_MS = 60_000;

/**
 * Gridworld's instance plugin (SP2 spec §4). It pushes the tile config, with the controller's biter toggles once it has
 * them (the controller sends them at every start), every minute and whenever the toggles come; forwards Lua's planet
 * and evolution reports to the controller, and keeps each planet's day in step with the controller's anchor on that
 * planet's own interval (surfaces spec §9.4). It holds no durable state, and an instance without the gridworld.tile
 * config is left alone.
 */
export default async function loadInstancePlugin(context: InstancePluginContext) {
	const { instance, plugin } = context;
	let clock = new OffsetClock();
	let anchor: Anchor | undefined;
	let reported: PlanetDay[] = [];
	/**
	 * The controller's latest biter toggles, for the minute re-sends only: Clusterio makes a new plugin object at every
	 * start, and the controller sends them again.
	 */
	let toggles: Toggles | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	/** W28: one interval per synced planet, armed once, cleared at every start, stop and exit. */
	const timers = new Map<string, ReturnType<typeof setInterval>>();

	const bridge = openBridge(context, {
		// Surfaces spec §4.1 (W25): every report goes to the controller, and the planets' days arm their syncs.
		"gw.tile.planets": on(TilePlanetsPayload, report => {
			reported = report.planets;
			instance.sendTo("controller", new TilePlanetsEvent(report.planets.map(p => p.surface)));
			arm();
		}),
		// Cross-border biters spec §8: Lua's evolution report goes to the controller.
		"gw.evolution.report": on(EvolutionReportPayload, report => {
			instance.sendTo("controller", new EvolutionReportEvent(report.planets, report.timeFactor));
		}),
	});

	function sendConfig() {
		const config = instance.config.get("gridworld.tile");
		if (config) {
			bridge.send("gw.tile.config", toggles ? { ...config, toggles } : config);
		}
	}

	function start(surface: string, ticksPerDay: number) {
		const ticks = period(ticksPerDay);
		const send = () => {
			if (anchor) {
				const daytime = canonical({ ...anchor, ticksPerDay }, clock.now(Date.now()));
				bridge.send("gw.time", { surface, daytime, base: ticksPerDay, period: ticks });
			}
		};
		send();
		timers.set(surface, setInterval(send, ticks / 60 * 1000));
	}

	/**
	 * §9.4: once the anchor and Lua's planets are in, each planet with a day gets its own interval, armed once (the
	 * planet set can't change within a run: a mod change needs a restart, §4.4). Its first gw.time goes at arming,
	 * which always follows an applied config, since Lua reports only in answer to one.
	 */
	function arm() {
		const config = instance.config.get("gridworld.tile");
		if (!anchor || !config) {
			return;
		}
		for (const { surface, ticksPerDay } of synced(config.surface, anchor, reported)) {
			if (!timers.has(surface)) {
				start(surface, ticksPerDay);
			}
		}
	}

	function stop() {
		clearInterval(timer);
		timer = undefined;
		for (const t of timers.values()) {
			clearInterval(t);
		}
		timers.clear();
	}

	instance.handle(DaytimeAnchorEvent, async (event: DaytimeAnchorEvent) => {
		anchor = { epochMs: event.epochMs, epochDaytime: event.epochDaytime, ticksPerDay: event.ticksPerDay };
		clock.sample(event.sentAtMs, Date.now());
		arm();
	});
	instance.handle(EvolutionApplyEvent, async (event: EvolutionApplyEvent) => {
		bridge.send("gw.evolution.apply", { planets: event.planets });
	});
	// The biter toggles (owner, 2026-10-10) go to Lua at once; Lua applies them at every config.
	instance.handle(TogglesEvent, async (event: TogglesEvent) => {
		toggles = event.toggles;
		sendConfig();
	});
	instance.hooks.start.attach(plugin.name, async () => {
		// The offset's samples count "since the instance started" (§11.1); the planets come with this boot's report.
		clock = new OffsetClock();
		anchor = undefined;
		reported = [];
		stop();
		if (instance.config.get("gridworld.tile")) {
			sendConfig();
			timer = setInterval(sendConfig, CONFIG_MS);
		}
	});
	instance.hooks.stop.attach(plugin.name, async () => stop());
	instance.hooks.exit.attach(plugin.name, () => stop());
}
