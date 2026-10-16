local t = require("modules/v2_test/testlib")
local loop = require("modules/v2_test/loopback")
local border = require("modules/gridworld/border")
local cloud = require("modules/gridworld/cloud")
local cloud_core = require("modules/gridworld/cloud_core")

-- The sweep, the leak report and the virtual cloud (cross-border biters spec §4, §5; plan Task 5). Each case: a surface of
-- its own, paved (refined concrete absorbs nothing), a gridworld record for tile (0, 0) of T = 128 ([-64, 64) on each
-- axis: chunks -2..1), and border.rebuild() as the first config runs it. A loop edge joins the tile's east side (side a,
-- "<id>-x") to its own west side ("<id>-y"): what leaks east comes in on the west, a torus.
local T = 128
local EAST = { T / 2, -T / 2, 4 }
local WEST = { -T / 2, T / 2, 12 }

local function record(name)
	storage.gridworld.tiles[name] = { world = "bt", x = 0, y = 0, size = T, surface = name, seed = 1,
		x1 = -T / 2, y1 = -T / 2, x2 = T / 2, y2 = T / 2, swept = true }
end

local function setup(name, id)
	local surface = game.create_surface(name, { seed = 20200, autoplace_controls = { ["enemy-base"] = { size = 0 } } })
	record(name)
	loop.ground(-T, -T, T, T, name)
	border.rebuild()
	if id then
		loop.sync()
		loop.edge(id, T, {}, EAST, WEST, name)
	end
	return surface
end

t.case("border: the sweep zeroes the first row but the oracle's column, and a report's columns come in on the far "
	.. "side's first column, same rows (spec §4, §5)", function(ctx)
	local S, ID = "bt-sweep", "bt-sw"
	ctx.at(5, function()
		setup(S, ID)
		-- Review Focus 5: no sweep on a planet without a pollutant (Vulcanus); Gleba's spores are swept (spike 34 G1)
		for _, name in ipairs({ "vulcanus", "gleba" }) do
			if not game.get_surface(name) then
				game.planets[name].create_surface()
			end
			record(name)
		end
		border.rebuild()
		local gleba = 0
		for k in pairs(storage.gridworld.sweep) do
			ctx.expect(k:sub(1, 9) ~= "vulcanus|", "no sweep entry " .. k)
			gleba = gleba + (k:sub(1, 6) == "gleba|" and 1 or 0)
		end
		ctx.expect(gleba > 0, "Gleba has sweep entries")
	end)
	-- Two windows in, both sides' reports are live. Under min_to_diffuse (15) nothing spreads, so the sums are exact.
	ctx.at(1300, function()
		local surface = game.surfaces[S]
		for cy, v in pairs({ [-2] = 10, [-1] = 12, [0] = 9, [1] = 14 }) do
			surface.set_pollution({ 2 * 32 + 16, cy * 32 + 16 }, v)
		end
	end)
	ctx.at(1400, function()
		local surface = game.surfaces[S]
		ctx.expect(surface.get_pollution({ 80, -48 }) == 0 and surface.get_pollution({ 80, 48 }) == 0, "columns 0, 3 swept")
		-- pre-flight B8: from Task 7 the east side's oracle stands in this chunk and absorbs its 9, so the check is the sweep's
		ctx.expect(storage.gridworld.sweep[S .. "|2,0"] == nil and storage.gridworld.sweep[S .. "|2,-1"] ~= nil,
			"the oracle's column (2) isn't swept; column 1 is")
	end)
	local function arrived(offset)
		ctx.at(offset, function()
			local c = storage.gridworld.cloud[S]
			local g = c and c.grids[ID .. "-y"]
			if not g and offset < 2800 then
				return arrived(offset + 1)
			end
			ctx.expect(g ~= nil, "the west side's grid exists")
			if g then
				local rec = storage.gridworld.tiles[S]
				local function at(cy)
					return g.v[cloud_core.index(rec, -2, cy)]
				end
				ctx.expect(at(-2) == 10 and at(-1) == 12 and at(1) == 14, "10, 12, 14 on the west's first column; got "
					.. serpent.line(g.v))
				ctx.expect(cloud_core.total(g.v) == 36, "and nothing else")
				ctx.expect(g.x == 16, "the largest column (14, chunk row 1) sets the stretch: west local x 16; got " .. g.x)
			end
		end)
	end
	arrived(1401)
end)

t.case("border: a report gathered while the edge was down is dropped, not delivered on its return (Review Focus 2)",
	function(ctx)
		local S, ID = "bt-stale", "bt-st"
		ctx.at(5, function()
			setup(S, ID)
		end)
		ctx.at(1300, function()
			loop.activation(ID, false)
			game.surfaces[S].set_pollution({ 80, -48 }, 10) -- east column 0, swept while the side's stamp is still fresh
		end)
		ctx.at(1400, function()
			local e = storage.gridworld.sweep[S .. "|2,-2"]
			ctx.expect(e and e.acc == 10, "gathered: " .. tostring(e and e.acc))
		end)
		ctx.at(3000, function()
			loop.activation(ID, true)
		end)
		ctx.at(4400, function()
			ctx.expect(storage.gridworld.cloud[S].grids[ID .. "-y"] == nil, "nothing came in on the west side")
			ctx.expect(storage.gridworld.sweep[S .. "|2,-2"].acc == 0, "the gathered 10 was dropped")
		end)
	end)

t.case("cloud: one update is cloud_core.step with map_settings.pollution and the chunk's absorption; what crosses a live "
	.. "side goes to its onward bag under the grid's route (spec §5, §6.4)", function(ctx)
	local S = "bt-cloud"
	ctx.at(5, function()
		setup(S, nil)
		local c = cloud.state(S)
		c.absorb[1] = 5
		c.grids["e1|up"] = { route = "e1|up", v = { [1] = 1000 }, x = 16, top = 0, stamp = 0 }
		storage.gridworld.live[S .. "|n"] = game.tick -- the north side's report is live; the west side's isn't
		local p = game.map_settings.pollution
		local want, out = cloud_core.step({ [1] = 1000 }, 4, { [1] = 5 }, p.diffusion_ratio, p.min_to_diffuse)
		cloud.step(S, game.tick)
		local g, same = c.grids["e1|up"], true
		for i, x in pairs(want) do
			same = same and math.abs((g.v[i] or 0) - x) < 1e-9
		end
		ctx.expect(same and cloud_core.total(g.v) == cloud_core.total(want), "the grid is cloud_core.step's")
		ctx.expect(math.abs(c.onward.n["0|e1|up"] - out.n[1]) < 1e-9, "north: column 0, under the route")
		ctx.expect(next(c.onward.w) == nil, "west isn't live: nothing kept for it")
	end)
end)

t.case("cloud: a chunk's absorption counts its tiles and trees at their prototypes' rates (spec §5)", function(ctx)
	local S = "bt-absorb"
	ctx.at(5, function()
		local surface = setup(S, nil)
		local tiles = {}
		for x = 0, 31 do
			for y = 0, 31 do
				tiles[#tiles + 1] = { name = "grass-1", position = { x, y } }
			end
		end
		surface.set_tiles(tiles)
		for k = 0, 9 do
			surface.create_entity({ name = "tree-01", position = { 2 + 3 * k, 16 } })
		end
		local i = cloud_core.index(storage.gridworld.tiles[S], 0, 0)
		cloud.refresh({ surface = S, i = i, cx = 0, cy = 0 })
		local grass = prototypes.tile["grass-1"].absorptions_per_second.pollution
		local tree = -prototypes.entity["tree-01"].emissions_per_second.pollution
		local want = 1024 * grass * game.map_settings.pollution.ageing * cloud.TILE_PER_UPDATE
			+ 10 * tree * cloud.TREE_PER_UPDATE
		local got = storage.gridworld.cloud[S].absorb[i]
		ctx.expect(got and math.abs(got - want) < 1e-9, "absorb " .. tostring(got) .. ", want " .. want)
	end)
end)
