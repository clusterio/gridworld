local t = require("modules/v2_test/testlib")
local loop = require("modules/v2_test/loopback")
local border = require("modules/gridworld/border")
local cloud = require("modules/gridworld/cloud")
local cloud_core = require("modules/gridworld/cloud_core")
local biters = require("modules/universal_edges/transports/biters")

-- The spawner budget and raid formation (cross-border biters spec §5; plan Task 8), on border_game_test's torus: tile
-- (0, 0) of T = 128, its east side ("<id>-x") looped to its west ("<id>-y"). A biter-spawner at (-40, 8) stands in chunk
-- (-2, 0), the west side's first column; a grid for route "<id>-y" (pollution that came in on the west side) holds 1000
-- there. Three unfuelled burner drills just inside the east line are what the raid attacks.
local T = 128

local function setup(name, id)
	local surface = game.create_surface(name, { seed = 20200, autoplace_controls = { ["enemy-base"] = { size = 0 } } })
	storage.gridworld.tiles[name] = { world = "bt", x = 0, y = 0, size = T, surface = name, seed = 1,
		x1 = -T / 2, y1 = -T / 2, x2 = T / 2, y2 = T / 2, swept = true }
	loop.ground(-T, -T, T, T, name)
	border.rebuild()
	if id then
		loop.sync()
		loop.edge(id, T, {}, { T / 2, -T / 2, 4 }, { -T / 2, T / 2, 12 }, name)
	end
	surface.create_entity({ name = "biter-spawner", position = { -40, 8 }, force = "enemy" })
	for _, p in ipairs({ { 40, 0 }, { 44, 0 }, { 40, 4 } }) do
		surface.create_entity({ name = "burner-mining-drill", position = p, force = "player" })
	end
	cloud.index(name)
end

local function cloud_at(name, key, amount)
	local c = cloud.state(name)
	local i = cloud_core.index(storage.gridworld.tiles[name], -2, 0)
	c.grids[key] = { route = key, v = { [i] = amount }, x = 48, top = 0, stamp = 0 }
	return c, i
end

--- Polls from offset until tick 3000 for the raid's small biters out by surface S's east line.
local function landed(ctx, S, offset)
	ctx.at(offset, function()
		local n = game.surfaces[S].count_entities_filtered({ name = "small-biter", area = { { 48, -16 }, { 64, 32 } } })
		if n == 0 and offset < 3000 then
			return landed(ctx, S, offset + 20)
		end
		ctx.expect(n > 0, "the raid came out by the east line")
	end)
end

t.case("raids: a spawner takes 20 + 0.01 v from the virtual cloud, gathers, and its raid walks to where the cloud came "
	.. "in, crosses and comes out on the far side (spec §5, §6)", function(ctx)
	local S, ID = "bt-gw-raid", "bt-gr"
	local key = ID .. "-y"
	ctx.at(5, function()
		setup(S, ID)
	end)
	ctx.at(60, function()
		local c, i = cloud_at(S, key, 1000)
		local _, sp = next(c.spawners)
		ctx.expect(sp ~= nil and sp.i == i, "the spawner is indexed in its chunk")
		cloud.budget(S, game.tick)
		-- pre-flight D1: within 1e-6, in case the prototype's 0.01 reads back as a float
		ctx.expect(math.abs(sp.pool - 30) < 1e-6 and math.abs(c.grids[key].v[i] - 970) < 1e-6,
			"took 20 + 0.01 x 1000 = 30; pool " .. sp.pool)
		ctx.expect(math.abs(sp.by[key] - 30) < 1e-6, "out of the west's grid")
		local ug = game.map_settings.unit_group
		ctx.expect(sp.raid and sp.raid.due >= game.tick + ug.min_group_gathering_time
			and sp.raid.due <= game.tick + ug.max_group_gathering_time, "gathering for vanilla's wait")
	end)
	landed(ctx, S, 100)
	ctx.expect_ipc("gridworld:out", '"phase":"formed"')
end)

t.case("raids: a thin cloud the spawner takes whole still raids after its grid is gone (E2E: A's real leak is 8-10 a "
	.. "window)", function(ctx)
	local S, ID = "bt-gw-thin", "bt-gt"
	local key = ID .. "-y"
	ctx.at(5, function()
		setup(S, ID)
	end)
	ctx.at(60, function()
		local c = cloud_at(S, key, 8)
		local _, sp = next(c.spawners)
		cloud.budget(S, game.tick)
		cloud.step(S, game.tick)
		ctx.expect(sp.raid ~= nil and c.grids[key] == nil, "took all 8 and gathers; the emptied grid is gone")
	end)
	landed(ctx, S, 100)
end)

t.case("raids: a spawner killed while its raid gathers forms nothing, and the budget carries on (Review Focus 3)",
	function(ctx)
		local S, ID = "bt-gw-kill", "bt-gk"
		ctx.at(5, function()
			setup(S, ID)
		end)
		ctx.at(60, function()
			local c = cloud_at(S, ID .. "-y", 1000)
			-- a second spawner in chunk (-2, -1), with the same grid's pollution in its chunk: it must carry on
			game.surfaces[S].create_entity({ name = "biter-spawner", position = { -40, -24 }, force = "enemy" })
			cloud.index(S)
			local i2 = cloud_core.index(storage.gridworld.tiles[S], -2, -1)
			c.grids[ID .. "-y"].v[i2] = 1000
			cloud.budget(S, game.tick)
			local un, sp, un2, sp2
			for k, v in pairs(c.spawners) do
				if v.i == i2 then
					un2, sp2 = k, v
				else
					un, sp = k, v
				end
			end
			ctx.expect(sp and sp.raid ~= nil and sp2 and sp2.raid ~= nil, "both gathering")
			local pool2 = sp2.pool
			sp.e.destroy()
			cloud.budget(S, game.tick)
			ctx.expect(c.spawners[un] == nil, "the killed spawner's entry is gone")
			ctx.expect(c.spawners[un2] == sp2 and sp2.pool ~= pool2, "the other spawner carried on: its budget ran")
			sp2.e.destroy() -- fixture: the survivor's own raid would come out too; only the killed one's absence is tested
		end)
		ctx.at(800, function()
			ctx.expect(game.surfaces[S].count_entities_filtered({ name = "small-biter", area = { { 48, -16 }, { 64, 32 } } }) == 0,
				"no raid came out")
		end)
	end)

t.case("raids: gridworld's locate names the x of the grid a raid's remaining route names; nil for none (R6)", function(ctx)
	ctx.at(5, function()
		local S = "bt-gw-locate"
		setup(S, nil)
		cloud.state(S).grids["e2|e1"] = { route = "e2|e1", v = { [1] = 50 }, x = 80, top = 0, stamp = 0 }
		local index = game.surfaces[S].index
		ctx.expect(biters.locate(index, { "e2", "e1" }) == 80, "the grid's x")
		ctx.expect(biters.locate(index, { "e2" }) == nil, "no grid for that route")
	end)
end)
