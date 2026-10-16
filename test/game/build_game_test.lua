local t = require("modules/v2_test/testlib")
local tile = require("modules/gridworld/tile")

-- The shared tile (tile_game_test.lua): (40, 40) at T = 64, configured at tick 100. This file owns tick 90, 400-499
-- and the robot's poll to 3000; 430 and 440 are the surfaces plan's (a platform, a surface that is no planet, and
-- Gleba). Robots and the roboport are the player force's, so cleanup never touches them.
local T, TY = 64, 40

--- Make an area buildable: grass, and no tree, rock, cliff or ore.
local function land(surface, x1, y1, x2, y2, name)
	local tiles = {}
	for x = math.floor(x1), math.ceil(x2) - 1 do
		for y = math.floor(y1), math.ceil(y2) - 1 do
			tiles[#tiles + 1] = { name = name or "grass-1", position = { x, y } }
		end
	end
	surface.set_tiles(tiles)
	local area = { { x1, y1 }, { x2, y2 } }
	for _, e in pairs(surface.find_entities_filtered({ area = area, type = { "tree", "simple-entity", "cliff", "resource" } })) do
		e.destroy()
	end
end

--- The build event a player's placement raises, for a player who isn't there (65536 is the highest index
--- get_player accepts; a higher one errors): game tests have no connected player.
local function built(e)
	tile.on_built_entity({ entity = e, player_index = 65536, tick = game.tick, name = defines.events.on_built_entity })
end

t.case("build: with no tile stored, a build outside is left alone", function(ctx)
	ctx.at(90, function()
		local surface = game.get_surface("nauvis")
		ctx.expect(next(storage.gridworld.tiles) == nil, "no tile yet")
		land(surface, 18, 18, 23, 23)
		local chest = surface.create_entity({ name = "wooden-chest", position = { 20.5, 20.5 }, force = "player" })
		built(chest)
		ctx.expect(chest ~= nil and chest.valid, "untouched")
		if chest then
			chest.destroy()
		end
	end)
end)

t.case("build: a centre outside is destroyed, ghosts included; a centre inside stays, however far it reaches", function(ctx)
	ctx.at(420, function()
		local surface = game.get_surface("nauvis")
		local b = storage.gridworld.tiles.nauvis
		local y = TY * T + 20
		land(surface, b.x1 - 4, y - 8, b.x2 + 8, y + 8)
		local function make(name, x, dy)
			local e = surface.create_entity({ name = name, position = { x, y + dy }, force = "player" })
			ctx.expect(e ~= nil, name .. " created")
			return e
		end
		local chest = make("wooden-chest", b.x2 + 0.5, 0.5)
		local on_east_line = make("stone-furnace", b.x2, 4)
		local on_west_line = make("stone-furnace", b.x1, 4)
		local straddling = make("assembling-machine-1", b.x2 - 0.5, -4.5)
		local ghost = surface.create_entity({
			name = "entity-ghost", inner_name = "wooden-chest", position = { b.x2 + 2.5, y + 0.5 }, force = "player",
		})
		local barrier = surface.create_entity({ name = "ue-barrier", position = { b.x2 + 20, y }, force = "neutral" })
		for _, e in ipairs({ chest, on_east_line, on_west_line, straddling, ghost, barrier }) do
			if e then
				built(e)
			end
		end
		ctx.expect(chest ~= nil and not chest.valid, "a chest past the east line is destroyed")
		ctx.expect(on_east_line ~= nil and not on_east_line.valid, "a centre on the east line is outside")
		ctx.expect(on_west_line ~= nil and on_west_line.valid, "a centre on the west line is inside")
		ctx.expect(straddling ~= nil and straddling.valid, "an assembler across the border, its centre inside, stays")
		ctx.expect(ghost ~= nil and not ghost.valid, "a ghost outside is destroyed")
		ctx.expect(barrier ~= nil and barrier.valid, "UE's barrier is never touched")
		for _, e in ipairs({ on_west_line, straddling, barrier }) do
			if e and e.valid then
				e.destroy()
			end
		end
	end)
end)

t.case("build: a robot's build outside the border is destroyed; the robot builds nothing there", function(ctx)
	local ghost_at
	ctx.at(400, function()
		local surface = game.get_surface("nauvis")
		local b = storage.gridworld.tiles.nauvis
		local cx, cy = (b.x1 + b.x2) / 2, TY * T
		land(surface, cx - 8, cy - 8, b.x2 + 12, cy + 8)
		local function make(name, x, y)
			local e = surface.create_entity({ name = name, position = { x, y }, force = "player" })
			ctx.expect(e ~= nil, name .. " created")
			return e
		end
		local port = make("roboport", cx + 2, cy)
		make("substation", cx - 3, cy)
		local eei = make("electric-energy-interface", cx - 3, cy + 3)
		local chest = make("storage-chest", cx + 6.5, cy + 0.5)
		if eei then
			eei.power_production = 1e7
			eei.electric_buffer_size = 1e9
		end
		if chest then
			chest.insert({ name = "wooden-chest", count = 1 })
		end
		if port then
			port.insert({ name = "construction-robot", count = 1 })
		end
		-- A ghost made by script raises no build event, so it survives, and the robot builds it outside the border.
		ghost_at = { b.x2 + 8.5, cy + 0.5 }
		surface.create_entity({ name = "entity-ghost", inner_name = "wooden-chest", position = ghost_at, force = "player" })
	end)
	local function check(offset)
		ctx.at(offset, function()
			local surface = game.get_surface("nauvis")
			local built_there = surface.count_entities_filtered({ name = "wooden-chest", position = ghost_at })
			local ghosts = surface.count_entities_filtered({ ghost_name = "wooden-chest", position = ghost_at })
			if ghosts > 0 and offset < 3000 then
				check(offset + 50)
				return
			end
			ctx.expect(ghosts == 0, "a robot took the ghost")
			ctx.expect(built_there == 0, "and what it built outside is gone")
		end)
	end
	check(450)
	ctx.expect_ipc("gridworld:out", '"builder":"robot"')
end)

t.case("build: UE's circuit injectors (ue-link-combinator) survive an outside chunk's cleanup and a build event raised " ..
	"on them (circuit-link spec §10, §13.4)", function(ctx)
	ctx.at(470, function()
		local surface = game.get_surface("nauvis")
		local b = storage.gridworld.tiles.nauvis
		local x, y = b.x2 + 40.5, TY * T + 40.5
		land(surface, x - 4, y - 4, x + 4, y + 4)
		local mine = surface.create_entity({ name = "ue-link-combinator", position = { x, y }, force = "player" })
		local stray = surface.create_entity({ name = "ue-link-combinator", position = { x + 2, y }, force = "neutral" })
		tile.clean_chunk("nauvis", math.floor(x / 32), math.floor(y / 32))
		built(mine)
		built(stray)
		ctx.expect(mine.valid and stray.valid, "both survive: a ue- name is UE's (G8), on any force")
		mine.destroy()
		stray.destroy()
	end)
end)

-- logistic-link spec §9, §12.4 (plan ruling 11): no gridworld change is needed, because UE's link chests are UE's by
-- name. They survive an outside chunk's cleanup and a build event raised on them, owned or orphaned (N2), while a
-- chest built beside them outside the tile is destroyed (D28). This case pins Task 1's ue- names, so it is a regression
-- pin: it passes before the removal task's code exists and must keep passing.
t.case("build: the logistic link's chests survive an outside chunk's cleanup and a build event raised on them; a " ..
	"chest built beside them is destroyed", function(ctx)
	ctx.at(480, function()
		local surface = game.get_surface("nauvis")
		local b = storage.gridworld.tiles.nauvis
		local x, y = b.x2 + 52.5, TY * T + 40.5
		land(surface, x - 4, y - 4, x + 4, y + 4)
		local req = surface.create_entity({ name = "ue-link-requester-chest", position = { x, y }, force = "player",
			quality = "uncommon" })
		local prov = surface.create_entity({ name = "ue-link-provider-requester-chest", position = { x + 2, y },
			force = "player" })
		local stray = surface.create_entity({ name = "ue-link-provider-requester-chest", position = { x - 2, y },
			force = "neutral" })
		local beside = surface.create_entity({ name = "wooden-chest", position = { x, y + 2 }, force = "player" })
		tile.clean_chunk("nauvis", math.floor(x / 32), math.floor(y / 32))
		for _, e in ipairs({ req, prov, stray, beside }) do
			built(e)
		end
		ctx.expect(req.valid and prov.valid and stray.valid, "every link chest survives: a ue- name is UE's (G8)")
		ctx.expect(not beside.valid, "the wooden chest built beside them, outside the tile, is destroyed")
		for _, e in ipairs({ req, prov, stray }) do
			e.destroy()
		end
	end)
end)

t.case("build: on a space platform's surface and on a surface that is no planet, nothing is gridworld's — builds, " ..
	"enemies, chunks and characters there are left alone (surfaces spec §8.3, W16)", function(ctx)
	ctx.at(430, function()
		local platform = game.forces.player.create_space_platform({
			name = "gw-platform", planet = "nauvis", starter_pack = "space-platform-starter-pack",
		})
		if platform then
			platform.apply_starter_pack()
		end
		ctx.expect(platform ~= nil and platform.surface ~= nil, "a platform with a surface (U12)")
		local b = storage.gridworld.tiles.nauvis
		local x, y = b.x2 + 20.5, TY * T + 0.5 -- outside the tile's bounds, were they this surface's
		local cases = { { game.create_surface("gw-other"), "grass-1" } }
		if platform and platform.surface then
			cases[2] = { platform.surface, "space-platform-foundation" }
		end
		for _, c in ipairs(cases) do
			local surface, ground = c[1], c[2]
			surface.request_to_generate_chunks({ x, y }, 0)
			surface.force_generate_chunk_requests()
			land(surface, x - 4, y - 4, x + 4, y + 4, ground)
			local chest = surface.create_entity({ name = "wooden-chest", position = { x, y }, force = "player" })
			ctx.expect(chest ~= nil, surface.name .. ": a chest")
			if chest then
				built(chest)
				ctx.expect(chest.valid, surface.name .. ": a build outside the bounds is left alone")
				tile.on_enemy({ entity = chest })
				ctx.expect(chest.valid, surface.name .. ": and so is it by the enemy rule")
				chest.destroy()
			end
			local prefix, queued_here = surface.name .. "|", false
			for k in pairs(storage.gridworld.cleanup) do
				queued_here = queued_here or string.sub(k, 1, #prefix) == prefix
			end
			ctx.expect(not queued_here, surface.name .. ": its generated chunk wasn't queued for cleanup")
		end
		if platform then
			platform.destroy()
		end
	end)
end)

t.case("build: on Gleba, a centre outside is destroyed and a centre inside stays (surfaces spec §8.2)", function(ctx)
	ctx.at(440, function()
		local surface = game.get_surface("gleba")
		local b = storage.gridworld.tiles.gleba
		local y = TY * T + 20
		land(surface, b.x2 - 4, y - 4, b.x2 + 4, y + 4)
		local outside = surface.create_entity({ name = "wooden-chest", position = { b.x2 + 0.5, y + 0.5 }, force = "player" })
		local inside = surface.create_entity({ name = "wooden-chest", position = { b.x2 - 1.5, y + 0.5 }, force = "player" })
		ctx.expect(outside ~= nil and inside ~= nil, "two chests on Gleba")
		if outside and inside then
			built(outside)
			built(inside)
			ctx.expect(not outside.valid, "outside: destroyed")
			ctx.expect(inside.valid, "inside: kept")
			inside.destroy()
		end
	end)
end)
