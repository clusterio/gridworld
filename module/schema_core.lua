-- Gridworld's storage migrations (SP0 spec §7.4): list[i] upgrades storage.gridworld from schema i - 1 to i.
-- State shapes are final for new worlds (owner, 2026-10-14); a live world is upgraded outside the plugins,
-- with throwaway one-time commands at deploy.
return {
	-- 1: the table exists (sub-project 0).
	function() end,
	-- 2: the tile (SP2 spec §5.3). tile and gen stay nil until the first config and a boot's generation.
	-- limits and stats are Planning ruling 2's: rate limits and counters must live in storage.
	function(state)
		state.configured = false
		state.swept = false
		state.cleanup = {}
		state.time = {}
		state.limits = {}
		state.stats = { syncs = 0, snaps = 0, max_drift = 0, chunks = 0, entities = 0 }
	end,
	-- 3: one tile record per planet surface (surfaces spec §8.1), keyed by surface name, so this needs no game and stays
	-- pure for lua5.2 (W9). The old tile, its sweep and generation become the base planet's record; cleanup
	-- entries gain the surface. day isn't migrated: every boot's first config sets it.
	function(state)
		local t = state.tile
		local cleanup = {}
		state.tiles, state.time = {}, {}
		if t then
			t.swept, t.gen = state.swept, state.gen
			state.tiles[t.surface] = t
			for _, c in pairs(state.cleanup) do
				cleanup[string.format("%s|%d,%d", t.surface, c.cx, c.cy)] = { surface = t.surface, cx = c.cx, cy = c.cy }
			end
		end
		state.cleanup = cleanup
		state.tile, state.swept, state.gen = nil, nil, nil
	end,
	-- 4: outside decoratives are now destroyed beyond the border band; chunks cleaned before it kept theirs, so every record
	-- is swept again and the next config re-queues its generated outside chunks (cleaning entities twice is harmless).
	function(state)
		for _, t in pairs(state.tiles) do
			t.swept = false
		end
	end,
	-- 5 (cross-border biters, plan Task 3): every record is swept again, so the next config re-queues its generated outside
	-- chunks and their cleanup places the second row's sinks (spec §4); and the border's tables: the first-row sweep, the
	-- live sides' last reports, the virtual cloud per planet and its absorption queue (spec §5), and each planet's
	-- evolution parts as this tile last reported them (spec §8).
	function(state)
		for _, t in pairs(state.tiles) do
			t.swept = false
		end
		state.sweep, state.live, state.cloud, state.absorb_q, state.evolution = {}, {}, {}, {}, {}
	end,
}
