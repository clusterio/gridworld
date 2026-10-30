-- The border (cross-border biters spec §4): the sinks in each tile's second outside row; the sweep of the first, every 64
-- ticks; and the leak report each live side sends its neighbour once a window over gridworld's built-in pollution
-- connector (cid "p", stream lanes, plan ruling R3), whose arrivals feed the virtual cloud (spec §5). All on a surface
-- whose pollutant is on (border_core.POLLUTANTS).
local ue = require("modules/universal_edges")
local tile_core = require("modules/gridworld/tile_core")
local core = require("modules/gridworld/border_core")
local cloud = require("modules/gridworld/cloud")

local border = {}
local send = ue.runtime.bridge.channel("gridworld")

--- The surface's pollutant's name when its border is on, or nil (no pollutant: Vulcanus, Fulgora, Aquilo).
function border.pollutant(surface)
	local p = surface.pollutant_type
	return p and core.POLLUTANTS[p.name] and p.name or nil
end

--- Spec §4: an outside chunk of t in the second row gets one sink at its centre, once; tile.clean_chunk calls this for
--- every outside chunk, at generation and after a re-sweep. Always placed (owner, 2026-10-16): the toggle covers the sweep
--- and the report only.
function border.sink(t, surface, cx, cy)
	if tile_core.ring(t, cx, cy) ~= 2 or not border.pollutant(surface) or not prototypes.entity[core.SINK] then
		return -- no sink prototype: the UE mod in the pack predates it (as barriers.place skips a missing ue-barrier)
	end
	local area = { { cx * 32, cy * 32 }, { cx * 32 + 32, cy * 32 + 32 } }
	if surface.count_entities_filtered({ name = core.SINK, area = area, limit = 1 }) == 0 then
		surface.create_entity({ name = core.SINK, position = { cx * 32 + 16, cy * 32 + 16 }, force = "neutral" })
	end
end

--- At each boot's first config (tile.lua): every generated ring-2 chunk sunk again, for a world whose chunks were cleaned
--- before sinks were always placed; border.sink skips a chunk that has one.
function border.sink_all()
	for name, t in pairs(storage.gridworld.tiles) do
		local surface = game.get_surface(name)
		if surface then
			for cx = t.x1 / 32 - 2, t.x2 / 32 + 1 do
				for cy = t.y1 / 32 - 2, t.y2 / 32 + 1 do
					if tile_core.ring(t, cx, cy) == 2 and surface.is_chunk_generated({ cx, cy }) then
						border.sink(t, surface, cx, cy)
					end
				end
			end
		end
	end
end

--- At each boot's first config (tile.lua): the first rows of every record whose pollutant is on, each chunk keeping what
--- it gathered, and each such record's cloud state and absorption queue.
function border.rebuild()
	local s = storage.gridworld
	local sweep, q = {}, {}
	for name, t in pairs(s.tiles) do
		local surface = game.get_surface(name)
		if surface and border.pollutant(surface) then
			for _, c in ipairs(core.row1(t)) do
				local k = string.format("%s|%d,%d", name, c.cx, c.cy)
				c.surface, c.acc = name, s.sweep[k] and s.sweep[k].acc or 0
				sweep[k] = c
			end
			cloud.rebuild(name, t, q)
		end
	end
	s.sweep, s.absorb_q = sweep, q
end

--- A pollution endpoint's record, side and surface; nil when its frame is no side of its surface's tile (an edge that
--- isn't gridworld's) or the surface's pollutant is off.
function border.side(ep)
	local surface = ep.frame.surface_index and game.get_surface(ep.frame.surface_index)
	local t = surface and border.pollutant(surface) and storage.gridworld.tiles[surface.name]
	local side = t and core.side_of(t, ep.frame)
	if side then
		return t, side, surface
	end
	return nil
end

--- Spec §4: first-row chunk c's pollution is read and zeroed. A side's chunk keeps what it held for the report while that
--- side's edge is live (border_core.fresh); a corner's, or a dead side's, goes. Nothing while the pollution_border toggle
--- is off: the pollution then leaks past the border, as before the sweep.
function border.sweep(c, tick)
	local surface = game.get_surface(c.surface)
	if not surface or not core.on(storage.gridworld.toggles, "pollution_border") then
		return
	end
	local p = { c.cx * 32 + 16, c.cy * 32 + 16 }
	local v = surface.get_pollution(p)
	if v > 0 then
		surface.set_pollution(p, 0)
		if c.side and core.fresh(storage.gridworld.live[c.surface .. "|" .. c.side], tick) then
			c.acc = c.acc + v
		end
	end
end

-- Spec §4: every 64 ticks, spread over ticks, each first-row chunk is swept.
ue.runtime.scheduler.iterate({
	name = "gw.sweep",
	per_tick = 4,
	interval = 64,
	source = function()
		return storage.gridworld and storage.gridworld.sweep
	end,
	fn = function(_, c, tick)
		border.sweep(c, tick)
	end,
})

ue.connectors.register_type({
	name = "gw_pollution",
	builtin = "p",
	lanes = function()
		return { ab = "stream", ba = "stream" }
	end,
	schedule = { per_tick = 2, interval = core.WINDOW },
	build = function()
		return "ready"
	end,
	teardown = function() end,
	--- Spec §4's leak report, once a window: this side's swept columns and the cloud's onward flow (spec §6.4), sent only
	--- when non-zero. The first report after a gap of more than two windows (the edge was down) is dropped, not delivered
	--- (Review Focus 2). None while the pollution_border toggle is off: the side then goes stale, so the cloud keeps no
	--- onward flow for it and what was gathered before is dropped, as for a gap.
	poll = function(ep, tick)
		local _, side, surface = border.side(ep)
		if not side or not core.on(storage.gridworld.toggles, "pollution_border") then
			return
		end
		local s = storage.gridworld
		local key = surface.name .. "|" .. side
		local stale = s.live[key] ~= nil and not core.fresh(s.live[key], tick)
		s.live[key] = tick
		local own = {}
		for _, c in pairs(s.sweep) do
			if c.surface == surface.name and c.side == side then
				own[c.col] = (own[c.col] or 0) + c.acc
				c.acc = 0
			end
		end
		local onward = cloud.take(surface.name, side)
		local bag = not stale and core.bag(own, onward, ep.edge)
		if bag then
			ep:send(ep.me == "a" and "ab" or "ba", bag)
			if storage.universal_edges.stream_trace then
				send("trace", { op = "gw.pollution", phase = "leak", level = "verbose", tick = tick, edge = ep.edge,
					surface = surface.name, side = side, bag = bag })
			end
		end
	end,
	--- Spec §5's input: each column of the neighbour's report comes in across from it (cloud.input).
	credit = function(ep, _, bag)
		local t, _, surface = border.side(ep)
		if t then
			for key, amount in pairs(bag) do
				local col, route = core.parse(key)
				if col then
					cloud.input(surface.name, t, ep.frame, ep.edge, col, route, amount)
				end
			end
		end
		return bag
	end,
	refund = function()
		return true
	end,
})

return border
