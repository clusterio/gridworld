-- The virtual cloud (cross-border biters spec §5): a neighbour's leaked pollution never goes onto this map, where script
-- pollution would never find a target and a failed search silences the planet. It lives here, one grid of chunk amounts
-- per route it came by (plan ruling R5), spread and absorbed by vanilla's rules every 64 ticks, and passed on where it
-- crosses another live side (spec §6.4). storage.gridworld.cloud[surface] = { grids = { [route] = { route, v = { [index]
-- = amount }, x, top, stamp } }, absorb = { [index] = amount per update }, onward = { [side] = { [bag key] = amount } },
-- spawners = {} }; a route is "<the edge it came in by>|<the route it named>" (border_core.key).
local ue = require("modules/universal_edges")
local geometry = require("modules/universal_edges/edges/geometry_core")
local core = require("modules/gridworld/cloud_core")
local border_core = require("modules/gridworld/border_core")

local cloud = {}
local send = ue.runtime.bridge.channel("gridworld")

--- The pollutants whose virtual cloud raids (plan ruling R11): Gleba's spores joined after spike 34 G3 and G4.
cloud.RAIDS = { pollution = true, spores = true }

--- What a tile's and a tree's absorption rate takes per 64-tick chunk update (spike 34 A1; spike 27: a tree-type sink of
--- rate R takes R per update).
cloud.TILE_PER_UPDATE, cloud.TREE_PER_UPDATE = 1, 1
--- ponytail: a grid whose whole cloud falls under this is gone (a spawner that took from it keeps its x, sp.at). A finer
--- threshold if thin clouds ever spread too far before they go.
cloud.GONE = 1

function cloud.state(name)
	local s = storage.gridworld
	local c = s.cloud[name]
	if not c then
		c = { grids = {}, absorb = {}, onward = { n = {}, e = {}, s = {}, w = {} }, spawners = {} }
		s.cloud[name] = c
	end
	return c
end

--- At each boot's first config (border.rebuild): record t's cloud state, and its chunks into the absorption queue q.
function cloud.rebuild(name, t, q)
	cloud.state(name)
	cloud.index(name)
	local n = (t.x2 - t.x1) / 32
	for i = 1, n * n do
		q[string.format("%s|%d", name, i)] = { surface = name, i = i, cx = t.x1 / 32 + (i - 1) % n,
			cy = t.y1 / 32 + math.floor((i - 1) / n) }
	end
end

--- Spec §5's input: column col of a neighbour's report (on its own frame) comes in at this side's first inside chunk across
--- from it, into the grid of its route: this edge, then the route it named. The report's largest column sets the grid's
--- stretch, x, where its raids cross (plan ruling R5).
function cloud.input(name, t, frame, edge, col, route, amount)
	local x = (frame.length / 32 - 1 - col) * 32 + 16 -- geometry.flip: the sender's column on this side's frame
	local wx, wy = geometry.to_world(frame, x, 16)
	local i = core.index(t, math.floor(wx / 32), math.floor(wy / 32))
	if not i then
		return
	end
	local key = route == "" and edge or (edge .. "|" .. route)
	local c = cloud.state(name)
	local g = c.grids[key]
	if not g then
		g = { route = key, v = {}, x = x, top = 0, stamp = 0 }
		c.grids[key] = g
	end
	g.v[i] = (g.v[i] or 0) + amount
	if g.stamp ~= game.tick then
		g.top, g.stamp = 0, game.tick -- one report's columns arrive in one tick
	end
	if amount > g.top then
		g.x, g.top = x, amount
	end
end

--- One update of every grid on surface name (spec §5): each chunk's absorption, then vanilla's diffusion; what crossed a
--- side whose report is live goes to that side's onward bag under the grid's route (spec §6.4); a grid under GONE goes.
function cloud.step(name, tick)
	local s = storage.gridworld
	local t, c = s.tiles[name], s.cloud[name]
	if not (t and c) then
		return
	end
	local n = (t.x2 - t.x1) / 32
	local p = game.map_settings.pollution
	for key, g in pairs(c.grids) do
		local v, out = core.step(g.v, n, c.absorb, p.diffusion_ratio, p.min_to_diffuse)
		g.v = v
		for side, flows in pairs(out) do
			if border_core.fresh(s.live[name .. "|" .. side], tick) then
				local onward = c.onward[side]
				for k, d in pairs(flows) do
					local bk = border_core.key(core.col(side, n, k), key)
					onward[bk] = (onward[bk] or 0) + d
				end
			end
		end
		if core.total(v) < cloud.GONE then
			c.grids[key] = nil
		end
	end
end

ue.runtime.scheduler.periodic({
	name = "gw.cloud",
	interval = 64,
	fn = function(tick)
		for name, c in pairs(storage.gridworld.cloud) do
			if next(c.grids) ~= nil then
				cloud.step(name, tick)
			end
		end
	end,
})

--- The onward bag entries of side, taken (the pollution connector's poll).
function cloud.take(name, side)
	local c = storage.gridworld.cloud[name]
	if not c then
		return {}
	end
	local out = c.onward[side]
	c.onward[side] = {}
	return out
end

--- Per pollutant, built once from the prototypes: { tiles = { [rate] = { names } }, trees = { [rate] = { names } } }.
--- ponytail: a file-local cache; prototypes are the same on every peer and never change while the game runs.
local RATES = {}

local function rates(pollutant)
	local r = RATES[pollutant]
	if r then
		return r
	end
	r = { tiles = {}, trees = {} }
	for name, p in pairs(prototypes.tile) do
		local a = p.absorptions_per_second and p.absorptions_per_second[pollutant]
		if a and a > 0 then
			r.tiles[a] = r.tiles[a] or {}
			table.insert(r.tiles[a], name)
		end
	end
	for name, p in pairs(prototypes.get_entity_filtered({ { filter = "type", type = { "tree", "plant" } } })) do
		local e = p.emissions_per_second and p.emissions_per_second[pollutant]
		if e and e < 0 then
			r.trees[-e] = r.trees[-e] or {}
			table.insert(r.trees[-e], name)
		end
	end
	RATES[pollutant] = r
	return r
end

--- Spec §5: one chunk's ground and tree absorption per update, counted from its tiles and trees. a = { surface, i, cx,
--- cy }. (The sinks stand outside every tile, so they are never counted.)
function cloud.refresh(a)
	local surface = game.get_surface(a.surface)
	local c = storage.gridworld.cloud[a.surface]
	local p = surface and surface.pollutant_type
	if not (c and p) then
		return
	end
	local r = rates(p.name)
	local area = { { a.cx * 32, a.cy * 32 }, { a.cx * 32 + 32, a.cy * 32 + 32 } }
	local ground, trees = 0, 0
	for rate, names in pairs(r.tiles) do
		ground = ground + rate * surface.count_tiles_filtered({ area = area, name = names })
	end
	for rate, names in pairs(r.trees) do
		trees = trees + rate * surface.count_entities_filtered({ area = area, name = names })
	end
	c.absorb[a.i] = ground * game.map_settings.pollution.ageing * cloud.TILE_PER_UPDATE + trees * cloud.TREE_PER_UPDATE
end

-- Spec §5: absorption is counted once per chunk and refreshed slowly: one chunk a tick, a walk every 10 minutes.
ue.runtime.scheduler.iterate({
	name = "gw.absorb",
	per_tick = 1,
	interval = 36000,
	source = function()
		return storage.gridworld and storage.gridworld.absorb_q
	end,
	fn = function(_, a)
		cloud.refresh(a)
	end,
})

--- Spec §5: the record's spawners, found anew (every minute, and at rebuild), each keeping its pool, what it took per
--- route (by) and where that route came in (at), and any raid it gathers; one gone since goes with them.
function cloud.index(name)
	local t, c, surface = storage.gridworld.tiles[name], storage.gridworld.cloud[name], game.get_surface(name)
	if not (t and c and surface) then
		return
	end
	local found = {}
	for _, e in ipairs(surface.find_entities_filtered({ area = { { t.x1, t.y1 }, { t.x2, t.y2 } }, type = "unit-spawner",
		force = "enemy" })) do
		local un = e.unit_number
		found[un] = c.spawners[un] or { e = e, i = core.index(t, math.floor(e.position.x / 32),
			math.floor(e.position.y / 32)), pool = 0, by = {}, at = {} }
	end
	c.spawners = found
end

ue.runtime.scheduler.periodic({
	name = "gw.spawners",
	interval = 3600,
	fn = function()
		for name in pairs(storage.gridworld.cloud) do
			cloud.index(name)
		end
	end,
})

local function costs_of(weights, pollutant)
	local costs = {}
	for _, w in ipairs(weights) do
		local p = prototypes.entity[w.name]
		costs[w.name] = p and p.absorptions_to_join_attack and p.absorptions_to_join_attack[pollutant] or 0
	end
	return costs
end

--- Spec §5's raid: the bought units are made at the spawner and grouped, and walk (UE, spec §6) to where the route most of
--- the pool came by entered this tile (sp.at: the spawner's own take can empty a thin grid, which then goes, before the
--- gathering ends), then hop by hop up that route. Nothing bought: none.
local function form(surface, sp)
	local raid = sp.raid
	sp.raid = nil
	local key, most = nil, 0
	for k, v in pairs(sp.by) do
		if v > most then
			key, most = k, v
		end
	end
	local x = key and sp.at[key]
	sp.by, sp.at = {}, {}
	if #raid.units == 0 or not x then
		return
	end
	local group = surface.create_unit_group({ position = sp.e.position, force = "enemy" })
	for _, n in ipairs(raid.units) do
		local pos = surface.find_non_colliding_position(n, sp.e.position, 16, 0.5)
		local u = pos and surface.create_entity({ name = n, position = pos, force = "enemy" })
		if u then
			group.add_member(u)
		end
	end
	if #group.members == 0 then
		group.destroy() -- nothing could be made: no raid to trace or walk
		return
	end
	local route = {}
	for id in string.gmatch(key, "[^|]+") do
		route[#route + 1] = id
	end
	local id = ue.runtime.trace.new_id()
	send("trace", { op = "gw.raid", phase = "formed", level = "info", tick = game.tick, trace = id, surface = surface.name,
		spawner = sp.e.unit_number, members = #group.members, edge = route[1], x = x })
	ue.biters.walk(group, route[1], x, { kind = "raid", route = { table.unpack(route, 2) } }, id)
end

--- Spec §5, every 60 ticks: each spawner in a chunk with virtual pollution takes min(v, absolute + proportional x v) into
--- its virtual pool while the pool is at most the cap, out of each grid by its share (by[route]); a pool that pays for a
--- unit starts a raid's gathering for vanilla's wait (plan ruling R8), and each step until it ends buys what the pool
--- pays for, up to vanilla's map_settings.unit_group.max_unit_group_size units in all (200 by default; vanilla caps a
--- group the same way), and nothing more once the raid holds that many (the pool keeps its usual cap rule). Real
--- pollution is the engine's; the two pools never meet. Nothing while the cross_border_raids toggle is off: the cloud
--- keeps running, and the pools and any raid gathering wait, as they are, for it to be on again.
function cloud.budget(name, tick)
	local c = storage.gridworld.cloud[name]
	local surface = game.get_surface(name)
	local pollutant = surface and surface.pollutant_type and surface.pollutant_type.name
	if not (c and pollutant and cloud.RAIDS[pollutant] and border_core.on(storage.gridworld.toggles, "cross_border_raids")) then
		return
	end
	local evo = game.forces.enemy.get_evolution_factor(surface)
	for un, sp in pairs(c.spawners) do
		if not sp.e.valid then
			c.spawners[un] = nil -- killed: its pool and any raid it gathered go with it (Review Focus 3)
		else
			local ab = sp.e.prototype.absorptions_per_second
			ab = ab and ab[pollutant]
			if ab then
				local weights = core.weights(sp.e.prototype.result_units, evo)
				-- spike 34 G3: vanilla never sends wrigglers on attacks (ai_settings.join_attacks = false); buy only
				-- the units vanilla sends.
				local joining = {}
				for _, w in ipairs(weights) do
					local ai = prototypes.entity[w.name].ai_settings
					if not (ai and ai.join_attacks == false) then
						joining[#joining + 1] = w
					end
				end
				weights = joining
				local costs = costs_of(weights, pollutant)
				local v = 0
				for _, g in pairs(c.grids) do
					v = v + (g.v[sp.i] or 0)
				end
				if v > 0 and sp.pool <= core.cap(weights, costs) then
					local got = core.take(v, ab.absolute, ab.proportional)
					for key, g in pairs(c.grids) do
						local x = g.v[sp.i]
						if x then
							g.v[sp.i] = x - got * x / v
							sp.by[key] = (sp.by[key] or 0) + got * x / v
							sp.at[key] = g.x
						end
					end
					sp.pool = sp.pool + got
				end
				if sp.raid then
					local bought
					bought, sp.pool = core.buy(sp.pool, weights, costs, math.random,
						game.map_settings.unit_group.max_unit_group_size - #sp.raid.units)
					for _, n in ipairs(bought) do
						sp.raid.units[#sp.raid.units + 1] = n
					end
					if tick >= sp.raid.due then
						form(surface, sp)
					end
				elseif sp.pool >= core.cheapest(weights, costs) then
					local ug = game.map_settings.unit_group
					sp.raid = { due = tick + math.random(ug.min_group_gathering_time, ug.max_group_gathering_time), units = {} }
				end
			end
		end
	end
end

ue.runtime.scheduler.periodic({
	name = "gw.budget",
	interval = 60,
	fn = function(tick)
		for name, c in pairs(storage.gridworld.cloud) do
			if next(c.spawners) ~= nil then
				cloud.budget(name, tick)
			end
		end
	end,
})

-- Plan ruling R6: a raid arriving here with route left walks to where that route's grid entered this tile.
ue.biters.on_locate(function(surface_index, route)
	local surface = game.get_surface(surface_index)
	local c = surface and storage.gridworld.cloud[surface.name]
	local g = c and c.grids[table.concat(route, "|")]
	return g and g.x
end)

return cloud
