local t = require("modules/v2_test/testlib")
-- Factorio allows require only while the file loads, never inside a step.
local core = require("modules/gridworld/tile_core")
local tile = require("modules/gridworld/tile")

-- Gridworld's game-test files share one tile, configured here at tick 100: tile (40, 40) of a T = 64 world, far from
-- the spawn area, so its whole generation square starts ungenerated — on every planet of the test mod set, Space Age's
-- five (surfaces spec §7). UE's last ue.edge.sync is at 95, and UE's runtime case raises on_server_startup at 3900. Each
-- gridworld file owns its ticks: build 90 and 400-499; tile 97-199, a drain poll every 100 ticks to 3800, and 3810;
-- time 200-299 and 2400-3850; corners 300-399 (Planning ruling 7). The tile's four planet surfaces
-- other than Nauvis are gridworld's alone in the shared save.
local T, TX, TY = 64, 40, 40
local PLANETS = { "aquilo", "fulgora", "gleba", "nauvis", "vulcanus" }
--- Each planet's day-night-cycle, as the probe recorded it (U7, docs/spikes/2026-10-05-12-planets-probe.md).
local DAYS = { vulcanus = 5400, gleba = 36000, fulgora = 10800, aquilo = 72000 }
local S1 = "gw-s1-vulcanus" -- a UE side that waits for Vulcanus (surfaces spec §11, S1)
local seq, ue_seq = 0, 0
local function deliver(msg_type, payload)
	seq = seq + 1
	ue_rt.inbox("gridworld", helpers.table_to_json({ { id = "00006e01." .. seq, type = msg_type, payload = payload } }))
end

local function deliver_ue(msg_type, payload)
	ue_seq = ue_seq + 1
	ue_rt.inbox("universal_edges", helpers.table_to_json({ { id = "00006e05." .. ue_seq, type = msg_type, payload = payload } }))
end

local function queued(msg_type)
	local found = {}
	for _, msg in ipairs(storage.universal_edges.bridge.out.gridworld or {}) do
		if msg.type == msg_type then
			found[#found + 1] = msg.payload
		end
	end
	return found
end

local function traced(phase)
	local found = {}
	for _, p in ipairs(queued("trace")) do
		if p.phase == phase then
			found[#found + 1] = p
		end
	end
	return found
end

--- The last gw.tile.planets report queued this tick, as { [surface] = ticksPerDay or "none" }, and how many there were.
local function reported()
	local reports = queued("gw.tile.planets")
	local days = {}
	for _, p in pairs(reports[#reports] and reports[#reports].planets or {}) do
		days[p.surface] = p.ticksPerDay or "none"
	end
	return days, #reports
end

local function config(fields)
	local c = {
		world = "gw-test", x = TX, y = TY, size = T, surface = "nauvis", seed = game.surfaces.nauvis.map_gen_settings.seed,
		trace = "00006e01.t1",
	}
	for k, v in pairs(fields or {}) do
		c[k] = v
	end
	return c
end

--- Make an area buildable: grass, and no tree, rock, cliff or ore.
local function land(surface, x1, y1, x2, y2)
	local tiles = {}
	for x = math.floor(x1), math.ceil(x2) - 1 do
		for y = math.floor(y1), math.ceil(y2) - 1 do
			tiles[#tiles + 1] = { name = "grass-1", position = { x, y } }
		end
	end
	surface.set_tiles(tiles)
	local area = { { x1, y1 }, { x2, y2 } }
	for _, e in pairs(surface.find_entities_filtered({ area = area, type = { "tree", "simple-entity", "cliff", "resource" } })) do
		e.destroy()
	end
end

t.case("tile: the first config tiles every planet — a surface each (Fulgora's adopted), a record, the spawn at the " ..
	"centre, one generation request and one generated each, a sweep for each new record, and the report (§7)", function(ctx)
	local fulgora_index
	ctx.at(97, function()
		-- S1: a UE side on Vulcanus (tile (40, 40)'s east border) arrives before Vulcanus exists.
		local h = T / 2
		deliver_ue("ue.edge.update", { edge = {
			id = S1, revision = 1, trace = S1 .. ".t", me = "a", owner = "test", length = T, deleted = false, connectors = {},
			a = { instanceId = 4242, surface = "vulcanus", origin = { TX * T + h, TY * T - h }, facing = 4 },
			b = { instanceId = 4243, surface = "vulcanus", origin = { TX * T + h, TY * T + h }, facing = 12 },
		} })
		local side = storage.universal_edges.edges[S1]
		ctx.expect(game.get_surface("vulcanus") == nil, "no Vulcanus yet")
		ctx.expect(side ~= nil and side.surface_index == nil, "the side waits without a surface")
	end)
	ctx.at(98, function()
		-- §7.2 step 1 (W7): a planet surface vanilla made first is adopted as it is, and swept: here one generated chunk.
		local surface = game.planets.fulgora.create_surface()
		fulgora_index = surface.index
		surface.request_to_generate_chunks({ 0, 0 }, 0)
		surface.force_generate_chunk_requests()
	end)
	ctx.at(100, function()
		deliver("gw.tile.config", config())
		local s = storage.gridworld
		ctx.expect(s.configured, "applied")
		for _, name in ipairs(PLANETS) do
			local rec, surface = s.tiles[name], game.get_surface(name)
			ctx.expect(surface ~= nil and rec ~= nil and rec.surface == name, name .. ": a surface and its record")
			if surface and rec then
				surface.peaceful_mode = true -- the build cases work beside this tile
				ctx.expect(rec.x == TX and rec.x1 == TX * T - T / 2 and rec.y2 == TY * T + T / 2, name .. ": the tile's bounds")
				ctx.expect(rec.swept and rec.gen ~= nil and rec.gen.pending == 121,
					name .. ": swept, and the square's 121 chunks pending; got " .. tostring(rec.gen and rec.gen.pending))
				local spawn = game.forces.player.get_spawn_position(surface)
				ctx.expect(spawn.x == TX * T and spawn.y == TY * T, name .. ": the spawn is the tile's centre")
			end
		end
		ctx.expect(game.planets.fulgora.surface.index == fulgora_index, "Fulgora's surface adopted, the same one")
		ctx.expect(s.cleanup["fulgora|0,0"] ~= nil, "and swept: its generated outside chunk is queued")
		local made = {}
		for _, p in ipairs(traced("planet_created")) do
			made[#made + 1] = p.surface
		end
		table.sort(made)
		ctx.expect(table.concat(made, ",") == "aquilo,gleba,vulcanus", "planet_created for the 3 gridworld made: "
			.. table.concat(made, ","))
		local configured = traced("configured")
		ctx.expect(#configured == 1 and configured[1].planets == 5, "configured once, with 5 planets")
		ctx.expect(#traced("generation_requested") == 5, "one generation request per planet")
		local days, reports = reported()
		ctx.expect(reports == 1 and days.nauvis ~= nil, "one report, Nauvis in it")
		for name, day in pairs(DAYS) do
			ctx.expect(days[name] == day, name .. " reported with its day " .. day .. ", got " .. tostring(days[name]))
		end
		ctx.expect(remote.call("freeplay", "get_skip_intro") and remote.call("freeplay", "get_disable_crashsite"),
			"no intro and no crash site")
		ctx.expect(remote.call("freeplay", "get_init_ran") == true, "freeplay's first-player chart is off (spike 31)")
		-- Benchmark mode advances async generation too (SP2 plan ruling 42); the test forces it, so the next steps run at
		-- a known tick.
		for _, name in ipairs(PLANETS) do
			game.get_surface(name).force_generate_chunk_requests()
		end
	end)
	ctx.at(102, function()
		local s = storage.gridworld
		local cx, cy, r = core.gen_square(TX, TY, T)
		for _, name in ipairs(PLANETS) do
			local surface = game.get_surface(name)
			local all, beyond = true, false
			for x = cx - r - 1, cx + r + 1 do
				for y = cy - r - 1, cy + r + 1 do
					if math.abs(x - cx) > r or math.abs(y - cy) > r then
						beyond = beyond or surface.is_chunk_generated({ x, y })
					else
						all = all and surface.is_chunk_generated({ x, y })
					end
				end
			end
			ctx.expect(s.tiles[name].gen == nil, name .. ": pending reached 0")
			ctx.expect(all and not beyond, name .. ": the whole square is generated, and nothing past it")
			local square = { { (cx - r) * 32, (cy - r) * 32 }, { (cx + r + 1) * 32, (cy + r + 1) * 32 } }
			for _, e in pairs(surface.find_entities_filtered({ area = square, force = "enemy" })) do
				e.destroy()
			end
		end
		-- S1: the Vulcanus side took the surface gridworld made at 100; its barriers stand on the generated chunks.
		local vulcanus = game.get_surface("vulcanus")
		local side = storage.universal_edges.edges[S1]
		ctx.expect(side ~= nil and side.surface_index == vulcanus.index, "the waiting side has Vulcanus (S1)")
		ctx.expect(vulcanus.count_entities_filtered({ name = "ue-barrier" }) == 7, "and its 7 barriers")
		deliver_ue("ue.edge.purged", { id = S1 })
		ctx.expect(storage.universal_edges.edges[S1] == nil and vulcanus.count_entities_filtered({ name = "ue-barrier" }) == 0,
			"purged, barriers and all")
	end)
	ctx.expect_ipc("gridworld:out", '"phase":"generated"')
	ctx.expect_ipc("gridworld:out", '"phase":"planet_created"')
	ctx.expect_ipc("universal_edges:out", '"phase":"surface_found"')
end)

t.case("tile: a later config in the boot applies nothing and is answered with the report; a malformed exclude is " ..
	"refused; the next boot applies the config again and generates nothing twice", function(ctx)
	ctx.at(104, function()
		deliver("gw.tile.config", config({ exclude = "gleba" }))
		local _, reports = reported()
		ctx.expect(reports == 0, "an exclude that isn't a list is refused, unanswered")
		deliver("gw.tile.config", config({ x = TX + 1, trace = "00006e01.t2" }))
		ctx.expect(#traced("configured") == 0 and #traced("generation_requested") == 0 and #traced("planet_created") == 0,
			"a repeat in the boot applies nothing")
		_, reports = reported()
		ctx.expect(reports == 1, "and is answered with the report")
		ctx.expect(storage.gridworld.tiles.nauvis.x == TX, "and changes nothing")
	end)
	ctx.at(106, function()
		local s = storage.gridworld
		tile.on_server_startup()
		ctx.expect(not s.configured and next(s.time) == nil, "a startup clears configured and the day's state")
		deliver("gw.tile.config", config())
		ctx.expect(s.configured and #traced("configured") == 1 and #traced("planet_created") == 0,
			"applied again; nothing created")
		local generated = traced("generated")
		ctx.expect(#traced("generation_requested") == 5 and #generated == 5, "requested again on every planet, generated at once")
		for _, g in ipairs(generated) do
			ctx.expect(g.chunks == 0, tostring(g.surface) .. ": the square exists")
		end
	end)
end)

t.case("tile: an excluded planet has no record and its queued chunks are skipped; a name the pack lacks changes " ..
	"nothing (Review Focus 5); an always-day planet is reported without a day; the next boot tiles it again", function(ctx)
	ctx.at(108, function()
		local s = storage.gridworld
		local aquilo = game.get_surface("aquilo")
		tile.on_server_startup()
		aquilo.always_day = true
		deliver("gw.tile.config", config({ exclude = { "gleba", "pluto" } }))
		aquilo.always_day = false
		ctx.expect(s.tiles.gleba == nil, "Gleba excluded: no record")
		local n = 0
		for _ in pairs(s.tiles) do
			n = n + 1
		end
		ctx.expect(n == 4 and traced("configured")[1].planets == 4,
			"every other planet tiled; pluto, which the pack lacks, changes nothing")
		local days = reported()
		ctx.expect(days.gleba == nil and days.aquilo == "none" and days.vulcanus == DAYS.vulcanus,
			"the report: no Gleba, Aquilo without a day (always_day)")
		local gleba = game.get_surface("gleba")
		local cx, cy = math.floor(s.tiles.nauvis.x1 / 32) - 1, TY * T / 32 -- the outside chunk west of the tile's centre row
		land(gleba, cx * 32, cy * 32, cx * 32 + 8, cy * 32 + 8)
		local rock = gleba.create_entity({ name = "big-rock", position = { cx * 32 + 4, cy * 32 + 4 } })
		ctx.expect(rock ~= nil and tile.clean_chunk("gleba", cx, cy) == 0 and rock.valid,
			"a queued Gleba chunk is skipped unread")
		if rock then
			rock.destroy()
		end
	end)
	ctx.at(110, function()
		local s = storage.gridworld
		tile.on_server_startup()
		deliver("gw.tile.config", config())
		ctx.expect(s.tiles.gleba ~= nil and s.tiles.gleba.swept, "the next boot tiles Gleba again: a new record, swept")
		ctx.expect(traced("configured")[1].planets == 5, "five planets again")
	end)
end)

t.case("tile: every config applies the biter toggles it carries: gridworld keeps them, UE gets raids and expansion, a " ..
	"change is logged once; a config without them keeps them; toggles that aren't a table are refused (owner, " ..
	"2026-10-10)", function(ctx)
	ctx.at(112, function()
		local s, b = storage.gridworld, storage.universal_edges.biters
		local off = { pollution_border = false, cross_border_raids = false, cross_border_expansion = true,
			shared_evolution = false }
		local on = { pollution_border = true, cross_border_raids = true, cross_border_expansion = true,
			shared_evolution = true }
		deliver("gw.tile.config", config({ toggles = off }))
		ctx.expect(s.toggles.pollution_border == false and s.toggles.cross_border_raids == false
			and s.toggles.cross_border_expansion and s.toggles.shared_evolution == false, "gridworld keeps all four")
		ctx.expect(b.enabled.raid == false and b.enabled.party, "UE: raids off, expansion on")
		ctx.expect(#traced("toggles") == 1, "the change is logged")
		deliver("gw.tile.config", config({ toggles = off }))
		ctx.expect(#traced("toggles") == 1, "the same toggles again: no line")
		deliver("gw.tile.config", config())
		ctx.expect(s.toggles.cross_border_raids == false and b.enabled.raid == false, "a config without them keeps them")
		local _, before = reported()
		deliver("gw.tile.config", config({ toggles = "off" }))
		local _, after = reported()
		ctx.expect(after == before and s.toggles.cross_border_raids == false, "toggles that aren't a table: refused, unanswered")
		deliver("gw.tile.config", config({ toggles = on }))
		ctx.expect(s.toggles.cross_border_raids and b.enabled.raid and b.enabled.party, "on again")
		ctx.expect(#traced("toggles") == 2, "and logged")
	end)
end)

t.case("tile: cleanup removes natural entities outside, never inside, and spares UE's and players' entities", function(ctx)
	local inside_tree
	ctx.at(120, function()
		local surface = game.surfaces.nauvis
		local b = storage.gridworld.tiles.nauvis
		local cx, cy = b.x1 / 32 - 1, TY * T / 32 -- the outside chunk west of the tile's centre row
		local x, y = cx * 32, cy * 32
		land(surface, x, y, b.x1 + 16, y + 32)
		inside_tree = surface.create_entity({ name = "tree-01", position = { b.x1 + 8, y + 4 } })
		local tree = surface.create_entity({ name = "tree-01", position = { x + 4, y + 4 } })
		local rock = surface.create_entity({ name = "big-rock", position = { x + 10, y + 10 } })
		local barrier = surface.create_entity({ name = "ue-barrier", position = { x + 20, y + 20 }, force = "neutral" })
		local chest = surface.create_entity({ name = "wooden-chest", position = { x + 4.5, y + 20.5 }, force = "player" })
		ctx.expect(tree and rock and barrier and chest and inside_tree, "the entities exist")
		ctx.expect(tile.clean_chunk("nauvis", cx, cy) >= 2, "at least the tree and the rock destroyed")
		ctx.expect(tree and not tree.valid and rock and not rock.valid, "the tree and the rock outside are gone")
		ctx.expect(barrier and barrier.valid and chest and chest.valid and inside_tree and inside_tree.valid,
			"a ue-barrier, a player chest and a tree inside stay")
		for _, e in ipairs({ barrier, chest }) do
			if e and e.valid then
				e.destroy()
			end
		end
	end)
	local function drained(offset)
		ctx.at(offset, function()
			local s = storage.gridworld
			if next(s.cleanup) ~= nil and offset < 3800 then
				drained(offset + 100)
				return
			end
			local backlog = 0
			for _ in pairs(s.cleanup) do
				backlog = backlog + 1
			end
			ctx.expect(backlog == 0, "the queue, every planet's, drained by tick 3800; " .. backlog .. " chunks left")
			local cx, cy, r = core.gen_square(TX, TY, T)
			local row = { { (cx - r) * 32, (cy - r) * 32 }, { (cx + r + 1) * 32, (cy - r + 1) * 32 } }
			local left = 0
			for _, e in pairs(game.surfaces.nauvis.find_entities_filtered({ area = row, force = { "neutral", "enemy" } })) do
				if not string.find(e.name, "^ue%-") then
					left = left + 1
				end
			end
			ctx.expect(left == 0, "the square's northern outside row is clean; found " .. left)
			ctx.expect(inside_tree ~= nil and inside_tree.valid, "the tree inside is untouched")
		end)
	end
	drained(200)
	ctx.expect_ipc("gridworld:out", '"phase":"drained"')
end)

t.case("tile: on Vulcanus and Aquilo too, cleanup removes natural entities outside, never inside (§8.2)", function(ctx)
	local inside = {}
	ctx.at(122, function()
		for _, name in ipairs({ "vulcanus", "aquilo" }) do
			local surface = game.get_surface(name)
			local b = storage.gridworld.tiles[name]
			local cx, cy = b.x1 / 32 - 1, TY * T / 32
			local x, y = cx * 32, cy * 32
			land(surface, x, y, b.x1 + 16, y + 32)
			local rock = surface.create_entity({ name = "big-rock", position = { x + 10, y + 10 } })
			inside[name] = surface.create_entity({ name = "big-rock", position = { b.x1 + 8, y + 4 } })
			ctx.expect(rock ~= nil and inside[name] ~= nil, name .. ": the rocks exist")
			ctx.expect(tile.clean_chunk(name, cx, cy) >= 1 and rock ~= nil and not rock.valid, name .. ": the rock outside is gone")
			ctx.expect(inside[name] ~= nil and inside[name].valid, name .. ": the rock inside stays")
		end
	end)
	ctx.at(3810, function()
		for name, rock in pairs(inside) do
			ctx.expect(rock.valid, name .. ": the rock inside is untouched after the drain")
			rock.destroy()
		end
	end)
end)

t.case("tile: a raised on_biter_base_built with its centre outside the tile destroys the base", function(ctx)
	ctx.at(130, function()
		local surface = game.get_surface("nauvis")
		local b = storage.gridworld.tiles.nauvis
		local x, y = b.x1 - 20, TY * T - 20
		land(surface, x - 5, y - 5, x + 5, y + 5)
		local spawner = surface.create_entity({ name = "biter-spawner", position = { x, y }, force = "enemy" })
		ctx.expect(spawner ~= nil, "a spawner outside")
		script.raise_biter_base_built({ entity = spawner })
		ctx.expect(spawner ~= nil and not spawner.valid, "destroyed")
	end)
end)

t.case("tile: cleanup destroys the decoratives of outside chunks more than 3 chunks out, never nearer or inside", function(ctx)
	ctx.at(124, function()
		local surface = game.surfaces.nauvis
		local b = storage.gridworld.tiles.nauvis
		local cy = TY * T / 32 -- the tile's centre row
		local name
		for _, proto in pairs(prototypes.decorative) do -- luacheck: ignore 512 (any one will do)
			name = proto.name
			break
		end
		local spots = {}
		for k, cx in pairs({ near = b.x1 / 32 - 3, far = b.x1 / 32 - 4, inside = b.x1 / 32 }) do
			local x, y = cx * 32 + 8.5, cy * 32 + 8.5
			surface.set_tiles({ { name = "grass-1", position = { x, y } } }) -- generates the chunk
			surface.destroy_decoratives({ area = { { cx * 32, cy * 32 }, { cx * 32 + 32, cy * 32 + 32 } } })
			surface.create_decoratives({ check_collision = false, decoratives = { { name = name, position = { x, y }, amount = 1 } } })
			spots[k] = { cx = cx, area = { { x - 0.5, y - 0.5 }, { x + 0.5, y + 0.5 } } }
			ctx.expect(#surface.find_decoratives_filtered({ area = spots[k].area }) > 0, k .. ": the decorative exists")
		end
		for k, p in pairs(spots) do
			if k ~= "inside" then
				tile.clean_chunk("nauvis", p.cx, cy)
			end
			local left = #surface.find_decoratives_filtered({ area = p.area })
			ctx.expect((left > 0) == (k ~= "far"), k .. ": decoratives left " .. left)
		end
	end)
end)
