local t = require("modules/v2_test/testlib")
local loop = require("modules/v2_test/loopback")
local connectors = require("modules/universal_edges/edges/connectors")
local border = require("modules/gridworld/border")
local tile = require("modules/gridworld/tile")
local border_core = require("modules/gridworld/border_core")
local cloud = require("modules/gridworld/cloud")
local cloud_core = require("modules/gridworld/cloud_core")

-- The pollution_border and cross_border_raids toggles (owner, 2026-10-10), on border_game_test's torus: tile (0, 0) of
-- T = 128, its east side ("<id>-x") looped to its west ("<id>-y"). The biters run's cases share one save, so a toggle is
-- off only within one step (with), never while another case runs.
local T = 128

local function setup(name, id)
	local surface = game.create_surface(name, { seed = 20200, autoplace_controls = { ["enemy-base"] = { size = 0 } } })
	storage.gridworld.tiles[name] = { world = "bt", x = 0, y = 0, size = T, surface = name, seed = 1,
		x1 = -T / 2, y1 = -T / 2, x2 = T / 2, y2 = T / 2, swept = true }
	loop.ground(-T, -T, T, T, name)
	border.rebuild()
	loop.sync()
	loop.edge(id, T, {}, { T / 2, -T / 2, 4 }, { -T / 2, T / 2, 12 }, name)
	return surface
end

--- fn() with storage.gridworld.toggles set to toggles; what was there is put back, even when fn fails.
local function with(toggles, fn)
	local s = storage.gridworld
	local was = s.toggles
	s.toggles = toggles
	local ok, err = pcall(fn)
	s.toggles = was
	if not ok then
		error(err, 0)
	end
end

t.case("toggles: pollution_border off, the first row isn't swept, no leak report goes, but the sink is placed (owner, 2026-10-16); on, "
	.. "the sweep and the report resume", function(ctx)
	local S, ID = "bt-tg-border", "bt-tgb"
	local SINK_AREA = { { 96, 0 }, { 128, 32 } } -- chunk (3, 0), in the second outside row
	ctx.at(5, function()
		setup(S, ID)
	end)
	-- Two windows in, the east side's report is live. Under min_to_diffuse (15) nothing spreads, so the sum is exact.
	ctx.at(1300, function()
		local surface, rec = game.surfaces[S], storage.gridworld.tiles[S]
		local c = storage.gridworld.sweep[S .. "|2,-2"] -- east column 0
		local ep = connectors.get(storage.universal_edges.edges[ID .. "-x"], "p")
		local poll = connectors.types.gw_pollution.poll
		local function sinks()
			return surface.count_entities_filtered({ name = border_core.SINK, area = SINK_AREA })
		end
		for _, e in ipairs(surface.find_entities_filtered({ name = border_core.SINK, area = SINK_AREA })) do
			e.destroy()
		end
		surface.set_pollution({ 80, -48 }, 6)
		c.acc = 5
		with({ pollution_border = false }, function()
			border.sweep(c, game.tick)
			poll(ep, game.tick)
			border.sink(rec, surface, 3, 0)
		end)
		ctx.expect(surface.get_pollution({ 80, -48 }) == 6, "off: not swept")
		ctx.expect(c.acc == 5, "off: no report took what was gathered")
		ctx.expect(sinks() == 1, "off: the sink is placed all the same")
		border.sweep(c, game.tick)
		ctx.expect(surface.get_pollution({ 80, -48 }) == 0 and c.acc == 11, "on: swept, into the report; acc " .. c.acc)
		poll(ep, game.tick)
		ctx.expect(c.acc == 0, "on: reported")
		border.sink(rec, surface, 3, 0)
		ctx.expect(sinks() == 1, "on: still the one sink")
	end)
	local function arrived(offset)
		ctx.at(offset, function()
			local c = storage.gridworld.cloud[S]
			local g = c and c.grids[ID .. "-y"]
			if not g and offset < 2000 then
				return arrived(offset + 1)
			end
			ctx.expect(g ~= nil and cloud_core.total(g.v) == 11, "the report's 11 came in on the west side; got "
				.. (g and serpent.line(g.v) or "nothing"))
		end)
	end
	arrived(1301)
end)

t.case("toggles: cross_border_raids off, a spawner with a full virtual pool buys nothing; on, its raid forms", function(ctx)
	local S, ID = "bt-tg-raid", "bt-tgr"
	ctx.at(5, function()
		setup(S, ID).create_entity({ name = "biter-spawner", position = { -40, 8 }, force = "enemy" })
		cloud.index(S)
	end)
	ctx.at(60, function()
		local c = cloud.state(S)
		local i = cloud_core.index(storage.gridworld.tiles[S], -2, 0)
		c.grids[ID .. "-y"] = { route = ID .. "-y", v = { [i] = 1000 }, x = 48, top = 0, stamp = 0 }
		local _, sp = next(c.spawners)
		sp.pool = 200
		with({ cross_border_raids = false }, function()
			cloud.budget(S, game.tick)
		end)
		ctx.expect(sp.raid == nil and sp.pool == 200 and c.grids[ID .. "-y"].v[i] == 1000, "off: nothing taken or bought")
		cloud.budget(S, game.tick)
		ctx.expect(sp.raid ~= nil, "on: the raid gathers")
	end)
	ctx.expect_ipc("gridworld:out", '"surface":"bt-tg-raid"') -- its gw.raid formed line, once gathered
end)

t.case("toggles: sinks are placed with pollution_border off, kept when it goes off, and sink_all fills the gaps (owner, "
	.. "2026-10-16)", function(ctx)
	local S, CX = "bt-tg-resink", 3 -- chunk (3, 0), in the second outside row of the tile
	local AREA = { { CX * 32, 0 }, { CX * 32 + 32, 32 } }
	ctx.at(5, function()
		game.create_surface(S, { seed = 20200, autoplace_controls = { ["enemy-base"] = { size = 0 } } })
		storage.gridworld.tiles[S] = { world = "bt", x = 0, y = 0, size = T, surface = S, seed = 1,
			x1 = -T / 2, y1 = -T / 2, x2 = T / 2, y2 = T / 2, swept = true }
		loop.ground(-T, -T, T, T, S)
	end)
	ctx.at(10, function()
		local s, surface = storage.gridworld, game.surfaces[S]
		local function sinks()
			return surface.count_entities_filtered({ name = border_core.SINK, area = AREA })
		end
		local was, configured = s.toggles, s.configured
		s.toggles, s.configured = { pollution_border = true }, true -- configured: the config applies only its toggles
		tile.clean_chunk(S, CX, 0)
		ctx.expect(sinks() == 1, "on: the cleaned chunk has its sink")
		ue_rt.inbox("gridworld", helpers.table_to_json({ { id = "00006e09.1", type = "gw.tile.config", payload = {
			world = "bt", x = 0, y = 0, size = T, surface = S, seed = 1, trace = "00006e09.t1",
			toggles = { pollution_border = false } } } }))
		ctx.expect(s.toggles.pollution_border == false, "the toggle is off")
		ctx.expect(sinks() == 1, "turning it off removes no sink; " .. sinks())
		for _, e in ipairs(surface.find_entities_filtered({ name = border_core.SINK, area = AREA })) do
			e.destroy()
		end
		tile.clean_chunk(S, CX, 0)
		ctx.expect(sinks() == 1, "off: a cleaned chunk gets a sink; " .. sinks())
		for _, e in ipairs(surface.find_entities_filtered({ name = border_core.SINK, area = AREA })) do
			e.destroy()
		end
		border.sink_all()
		ctx.expect(sinks() == 1, "sink_all adds a sink to a chunk that has none; " .. sinks())
		border.sink_all()
		ctx.expect(sinks() == 1, "and not a second one where there is one; " .. sinks())
		s.toggles, s.configured = was, configured
	end)
end)
