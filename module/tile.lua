-- The tile shell (SP2 spec §7.3, §9), one record per planet surface (surfaces spec §7, §8): the tile config, each
-- planet's surface, spawn and async generation request, the sweep of a new record, the sliced cleanup of outside
-- chunks, the build and enemy rules, and the day sync's shell. Nothing happens until a gw.tile.config tiles the
-- planets, so an instance that is no tile stays inert. A surface with no record — a platform's, a mod's that is no
-- planet, an excluded planet's — is never touched (W16).
local ue = require("modules/universal_edges")
local core = require("modules/gridworld/tile_core")
local time_core = require("modules/gridworld/time_core")
local border = require("modules/gridworld/border")

local runtime = ue.runtime
local tile = {}
local send = runtime.bridge.channel("gridworld")
local FORCES = { "neutral", "enemy" }
--- §16: a Lua anomaly is logged at most once per key per this many ticks, with a count.
local WINDOW = 3600
--- Surfaces spec §9.1 (S6): a day under 20 s (1200 ticks) isn't synced.
local MIN_DAY = 1200

--- Send one lifecycle event (SP0 §7.2): Lua's log() carries no structured fields.
function tile.emit(op, phase, level, id, fields)
	fields = fields or {}
	fields.op, fields.phase, fields.level, fields.trace, fields.tick = op, phase, level, id, game.tick
	send("trace", fields)
end

--- tile.emit at most once per key per WINDOW ticks; the line carries how many calls the key had meanwhile.
function tile.limited(key, op, phase, level, id, fields)
	local ok, count = core.allow(storage.gridworld.limits, key, game.tick, WINDOW)
	if ok then
		fields = fields or {}
		fields.count = count
		tile.emit(op, phase, level, id, fields)
	end
end

local function int(v)
	return type(v) == "number" and v % 1 == 0
end

--- §7.3; surfaces spec §8.2: exclude, when present, is a list of planet names; toggles, when present, a table.
local function valid(p)
	if p.toggles ~= nil and type(p.toggles) ~= "table" then
		return false
	end
	if p.exclude ~= nil then
		if type(p.exclude) ~= "table" then
			return false
		end
		for _, name in pairs(p.exclude) do
			if type(name) ~= "string" then
				return false
			end
		end
	end
	return type(p.world) == "string" and int(p.x) and int(p.y) and int(p.size) and p.size >= 64 and p.size <= 4096
		and p.size % 64 == 0 and type(p.surface) == "string" and int(p.seed) and type(p.trace) == "string"
end

--- A cleanup entry's key: the surface, then the chunk (W10: one queue for every planet). "%d" prints a -0 as "0", so a
--- key always matches on_chunk_generated's position (SP1a ruling 14).
local function key(surface, cx, cy)
	return string.format("%s|%d,%d", surface, cx, cy)
end

local function queue(t, cx, cy)
	storage.gridworld.cleanup[key(t.surface, cx, cy)] = { surface = t.surface, cx = cx, cy = cy }
end

--- §9.2, per record: one async request per boot, and never force_generate_chunk_requests. pending counts the square's
--- chunks not generated yet: O((2(T/64 + 4) + 1)^2) is_chunk_generated calls per planet once per boot, why T is
--- capped at 4096.
local function generate(surface, t)
	local cx, cy, r = core.gen_square(t.x, t.y, t.size)
	local pending = 0
	for x = cx - r, cx + r do
		for y = cy - r, cy + r do
			if not surface.is_chunk_generated({ x, y }) then
				pending = pending + 1
			end
		end
	end
	local id = runtime.trace.new_id()
	surface.request_to_generate_chunks({ t.x * t.size, t.y * t.size }, r)
	tile.emit("gw.world", "generation_requested", "info", id, { surface = t.surface, chunks = pending })
	if pending == 0 then
		t.gen = nil
		tile.emit("gw.world", "generated", "info", id, { surface = t.surface, chunks = 0 })
	else
		t.gen = { pending = pending, chunks = pending, trace = id }
	end
end

--- §9.3 for a new record (surfaces spec §7.2 step 7): queue the surface's generated outside chunks. A surface gridworld
--- just made has none (U1); an adopted one's are vanilla's (W7).
local function sweep(surface, t)
	for chunk in surface.get_chunks() do
		if core.chunk_outside(t, chunk.x, chunk.y) and surface.is_chunk_generated(chunk) then
			queue(t, chunk.x, chunk.y)
		end
	end
	t.swept = true
end

--- Surfaces spec §7.2 step 4: the planet's day in whole ticks; nil for no day cycle (always_day, or under 20 s: S6, W29).
local function day_of(surface)
	if surface.always_day then
		return nil
	end
	local day = math.floor(surface.get_property("day-night-cycle") + 0.5)
	return day >= MIN_DAY and day or nil
end

--- Surfaces spec §7.2: tile one planet at this boot's first config — its surface (adopted, or made), its record (the
--- bounds and day refreshed when it exists), the spawn at the tile's centre, the generation request, and the sweep of
--- a new record. Returns the record's key, the surface's name.
local function tile_planet(planet, p)
	local surface = planet.surface
	if not surface then
		surface = planet.create_surface()
		tile.emit("gw.tile", "planet_created", "info", p.trace, { surface = surface.name })
	end
	local name = surface.name
	local s = storage.gridworld
	local t = s.tiles[name] or { swept = false }
	s.tiles[name] = t
	local x1, y1, x2, y2 = core.bounds(p.x, p.y, p.size)
	t.world, t.x, t.y, t.size, t.surface, t.seed = p.world, p.x, p.y, p.size, name, p.seed
	t.x1, t.y1, t.x2, t.y2, t.day = x1, y1, x2, y2, day_of(surface)
	game.forces.player.set_spawn_position({ p.x * p.size, p.y * p.size }, surface)
	generate(surface, t)
	if not t.swept then
		sweep(surface, t)
	end
	return name
end

--- Surfaces spec §4.1: in answer to every config, each record's surface and its day (no ticksPerDay: no day cycle).
local function report()
	local planets = {}
	for name, t in pairs(storage.gridworld.tiles) do
		planets[#planets + 1] = { surface = name, ticksPerDay = t.day }
	end
	send("gw.tile.planets", { planets = planets })
end

--- The biter toggles (owner, 2026-10-10) of a config that carries them: kept for gridworld's own (border_core.on), and
--- the two UE acts on handed to it. A change is logged.
local function toggle(p)
	local s, kept, changed = storage.gridworld, {}, false
	for k, v in pairs(p.toggles) do
		kept[k], changed = v, changed or (s.toggles or {})[k] ~= v
	end
	s.toggles = kept
	ue.biters.set_enabled({ raids = kept.cross_border_raids, expansion = kept.cross_border_expansion })
	if changed then
		tile.emit("gw.tile", "toggles", "info", p.trace, p.toggles)
	end
end

--- §7.3; surfaces spec §7.1: the first config of each boot tiles every planet of game.planets not in its exclude list,
--- in the table's order, and drops the record of a planet no longer tiled (its mod removed, §4.4); that planet's queued
--- chunks are then skipped (tile.clean_chunk). Every later config in the boot applies nothing but the biter toggles,
--- which every config applies, so a change lands within seconds. Every valid config is answered with the report (W25),
--- so a lost one heals within a minute.
runtime.bridge.on("gridworld", "gw.tile.config", function(p)
	if not valid(p) then
		return false
	end
	local s = storage.gridworld
	if p.toggles then
		toggle(p)
	end
	if not s.configured then
		local excluded, tiled, n = {}, {}, 0
		for _, name in pairs(p.exclude or {}) do
			excluded[name] = true
		end
		for name, planet in pairs(game.planets) do
			if not excluded[name] then
				tiled[tile_planet(planet, p)] = true
				n = n + 1
			end
		end
		for name in pairs(s.tiles) do
			if not tiled[name] then
				s.tiles[name] = nil
			end
		end
		border.sink_all() -- sinks are always placed; a chunk cleaned before that rule has none
		border.rebuild() -- cross-border biters spec §4, §5: the sweep, the cloud and its absorption, for this boot's records
		local freeplay = remote.interfaces.freeplay
		if freeplay and freeplay.set_disable_crashsite and freeplay.set_skip_intro then
			remote.call("freeplay", "set_disable_crashsite", true)
			remote.call("freeplay", "set_skip_intro", true)
			-- Spike 31: freeplay charts ±200 tiles around the spawn (the tile's centre) for the first player; marking
			-- its first-player setup done leaves the map unrevealed. Freeplay has get_init_ran but no setter, so this writes
			-- its storage flag; the tile game test reads it back through get_init_ran.
			storage.init_ran = true
		end
		s.configured = true
		tile.emit("gw.tile", "configured", "info", p.trace, { x = p.x, y = p.y, world = p.world, planets = n })
	end
	report()
end)

--- §11.2, per planet at its own period (A15; surfaces spec §9.5): the day sync for the record of p.surface, while this
--- boot's config is applied. A surface with no record (excluded, a platform's, one this tile hasn't tiled) is ignored (Review Focus 4).
runtime.bridge.on("gridworld", "gw.time", function(p)
	if type(p.surface) ~= "string" or type(p.daytime) ~= "number" or p.daytime < 0 or p.daytime >= 1 or not int(p.base)
		or not int(p.period) or p.period < 300 or 4 * p.period > p.base then
		return false
	end
	local s = storage.gridworld
	local t = s.configured and s.tiles[p.surface]
	local surface = t and game.get_surface(t.surface)
	if not surface then
		return nil
	end
	local time = s.time[t.surface] or {}
	s.time[t.surface] = time
	if surface.freeze_daytime then
		-- §11.2: gridworld owns the day cycle of its planets' surfaces.
		surface.freeze_daytime = false
		if not time.unfrozen then
			time.unfrozen = true
			tile.emit("gw.time", "unfrozen", "warn", nil, { surface = t.surface })
		end
	end
	local d = surface.daytime
	local n = time.last_tick and game.tick - time.last_tick
	local tpd, snap = time_core.plan(d, p.daytime, p.base, n, time.last_c, p.period)
	local drift = time_core.wrap(p.daytime - d)
	if snap then
		surface.daytime = p.daytime
		s.stats.snaps = s.stats.snaps + 1
		tile.emit("gw.time", "snap", "info", nil, { surface = t.surface, drift = drift })
	end
	surface.ticks_per_day = tpd
	time.last_tick, time.last_c = game.tick, p.daytime
	s.stats.syncs = s.stats.syncs + 1
	s.stats.max_drift = math.max(s.stats.max_drift, math.abs(drift))
end)

--- A start, crash or rollback (§5.3): the config must be applied again, and the day law starts afresh on every planet.
function tile.on_server_startup()
	local s = storage.gridworld
	s.configured = false
	s.time = {}
end

--- §9.3 per record: an outside chunk is queued for cleanup; a chunk of this boot's square counts its record's
--- generation down. A surface with no record is ignored.
function tile.on_chunk_generated(event)
	local s = storage.gridworld
	local t = s and s.tiles and s.tiles[event.surface.name]
	if not t then
		return
	end
	local cx, cy = event.position.x, event.position.y
	if core.chunk_outside(t, cx, cy) then
		queue(t, cx, cy)
	end
	local gen = t.gen
	local gx, gy, r = core.gen_square(t.x, t.y, t.size)
	if gen and math.abs(cx - gx) <= r and math.abs(cy - gy) <= r then
		gen.pending = gen.pending - 1
		if gen.pending <= 0 then
			t.gen = nil
			tile.emit("gw.world", "generated", "info", gen.trace, { surface = t.surface, chunks = gen.chunks })
		end
	end
end

--- §9.3: destroy the natural entities of one outside chunk of surface name; UE's own (its barriers, the sinks) and every
--- player-force entity stay, and so do the decoratives of chunks within BAND chunks of the tile (core.chunk_far). A chunk
--- of the second row then gets its sink (cross-border biters spec §4). A surface with no record (a planet dropped since
--- the chunk was queued, §7.2) is skipped unread. Returns how many entities it destroyed.
function tile.clean_chunk(name, cx, cy)
	local surface = storage.gridworld.tiles[name] and game.get_surface(name)
	if not surface then
		return 0
	end
	local x, y = cx * 32, cy * 32
	local n = 0
	for _, e in ipairs(surface.find_entities_filtered({ area = { { x, y }, { x + 32, y + 32 } }, force = FORCES })) do
		if e.valid and not ue.owns(e) then
			e.destroy()
			n = n + 1
		end
	end
	if core.chunk_far(storage.gridworld.tiles[name], cx, cy) then
		surface.destroy_decoratives({ area = { { x, y }, { x + 32, y + 32 } } })
	end
	border.sink(storage.gridworld.tiles[name], surface, cx, cy)
	return n
end

--- §9.3: one queued chunk per tick, every planet's in one queue (W10); an empty walk when idle. The key is removed after
--- each chunk, so on_chunk_generated adding keys between ticks never meets a live cursor.
runtime.scheduler.iterate{
	name = "gw.cleanup",
	per_tick = 1,
	source = function()
		return storage.gridworld and storage.gridworld.cleanup
	end,
	fn = function(k, c)
		local s = storage.gridworld
		local n = tile.clean_chunk(c.surface, c.cx, c.cy)
		s.cleanup[k] = nil
		s.stats.chunks, s.stats.entities = s.stats.chunks + 1, s.stats.entities + n
		if next(s.cleanup) == nil then
			-- A table emptied key by key keeps its hash part, and next() on it walks every dead slot, every tick, from here
			-- on (about 10 µs a tick after a tile's first drain): a new table has none.
			s.cleanup = {}
			tile.emit("gw.cleanup", "drained", "info", nil, { chunks = s.stats.chunks, entities = s.stats.entities })
			s.stats.chunks, s.stats.entities = 0, 0
		end
	end,
}

--- Whether a player's or robot's build is gridworld's to remove (§9.4): its centre outside its surface's tile (v1's
--- rule, D28), and not UE's. A surface with no record has no tile, so nothing there is (W16).
local function outside(e)
	local t = e.valid and storage.gridworld.tiles[e.surface.name]
	if not t then
		return false
	end
	local p = e.position
	return not core.inside(t, p.x, p.y) and not ue.owns(e)
end

--- §9.4: a build outside is destroyed, ghosts included, with no refund (D28). Removing a ghost as it is placed is what
--- keeps robots from building outside. The builder is told at most once per 60 ticks.
local function destroy(e, builder, player)
	local name, surface = e.name, e.surface.name
	e.destroy()
	if player and core.allow(storage.gridworld.limits, "text:" .. player.index, game.tick, 60) then
		player.create_local_flying_text({ text = "Outside the tile border", create_at_cursor = true })
	end
	tile.limited("destroyed:" .. builder, "gw.cleanup", "destroyed", "info", nil,
		{ entity = name, builder = builder, surface = surface })
end

--- §9.4, a player's build. Script builds raise other events and are left to the script that made them.
function tile.on_built_entity(event)
	local e = event.entity
	if outside(e) then
		local player = game.get_player(event.player_index)
		destroy(e, player and player.name or "player", player)
	end
end

--- §9.4, a robot's build.
function tile.on_robot_built_entity(event)
	local e = event.entity
	if outside(e) then
		destroy(e, "robot", nil)
	end
end

--- §9.3: an enemy base built, or a unit spawned, with its centre outside its surface's tile is destroyed, as v1 did; UE's
--- own are kept (cross-border biters spec §6.3: the oracle's units spawn outside, plan ruling R14).
function tile.on_enemy(event)
	local e = event.entity
	local t = e.valid and storage.gridworld.tiles[e.surface.name]
	if t and not core.inside(t, e.position.x, e.position.y) and not ue.owns(e) then
		e.destroy()
	end
end

return tile
