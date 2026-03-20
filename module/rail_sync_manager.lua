local clusterio_api = require("modules/clusterio/api")

local rail_sync_manager = {}

rail_sync_manager.RAIL_TYPES = {
    ["straight-rail"] = true,
    ["curved-rail-a"] = true,
    ["curved-rail-b"] = true,
    ["half-diagonal-rail"] = true,
    ["legacy-straight-rail"] = true,
    ["legacy-curved-rail"] = true,
	["elevated-straight-rail"] = true,
    ["elevated-curved-rail-a"] = true,
    ["elevated-curved-rail-b"] = true,
    ["elevated-half-diagonal-rail"] = true,
    ["rail-ramp"] = true,
    ["rail-signal"] = true,
    ["rail-chain-signal"] = true,
    ["train-stop"] = true,
	["locomotive"] = true,
}

-- UE source train-stop names that sit outside tile bounds and must not be
-- destroyed by bounds-cleanup or on_chunk_generated on either tile or pathworld.

rail_sync_manager.UE_PROTECTED_NAMES = {
	["ue_source_trainstop"] = true,
}

-- Collect all rail entities within this tile's bounds and send them to the host via IPC.
-- Called periodically via on_nth_tick on normal (non-pathworld) tile instances.
function rail_sync_manager.collect_and_send_rail_entities()
	local config = storage.gridworld
	if config == nil or config.is_pathworld then return end
	if config.bounds == nil then return end

	local results = {}
	for _, surface in pairs(game.surfaces) do
		local entities = surface.find_entities_filtered {
			area = {
				left_top     = { x = config.bounds.min_x, y = config.bounds.min_y },
				right_bottom = { x = config.bounds.max_x, y = config.bounds.max_y },
			},
		}
		for _, entity in ipairs(entities) do
			if entity.valid and rail_sync_manager.RAIL_TYPES[entity.type] and entity.type ~= "entity-ghost"
				and not rail_sync_manager.UE_PROTECTED_NAMES[entity.name] then
				local entry = {
					name      = entity.name,
					type      = entity.type,
					surface   = surface.name,
					x         = entity.position.x,
					y         = entity.position.y,
					direction = entity.direction,
				}
				if entity.type == "train-stop" then
					entry.stopName   = entity.backer_name
					entry.priority   = entity.train_stop_priority
					local limit = entity.trains_limit
					entry.trainLimit = limit
					entry.trainCount = entity.trains_count
				end
				results[#results + 1] = entry
			end
		end
	end

	clusterio_api.send_json("gridworld:rail_entities", {
		tile_x    = config.tile_x,
		tile_y    = config.tile_y,
		tile_size = config.tile_size,
		entities  = results,
	})
end

-- Collect all ue_source_trainstop entities on every surface and send them via IPC.
-- UE stops sit outside the tile bounds so we search the full surface by name.
-- Called on the same on_nth_tick[900] cadence as rail entities.
function rail_sync_manager.collect_and_send_ue_stops()
	local config = storage.gridworld
	if config == nil or config.is_pathworld then return end

	local results = {}
	for _, surface in pairs(game.surfaces) do
		local entities = surface.find_entities_filtered { name = "ue_source_trainstop" }
		for _, entity in ipairs(entities) do
			if entity.valid then
				results[#results + 1] = {
					surface   = surface.name,
					x         = entity.position.x,
					y         = entity.position.y,
					direction = entity.direction,
					stopName  = entity.backer_name,
				}
			end
		end
	end

	clusterio_api.send_json("gridworld:ue_stops", {
		tile_x = config.tile_x,
		tile_y = config.tile_y,
		stops  = results,
	})
end

-- Apply a set of rail entities sent from a tile instance onto this pathworld surface.
-- Diffs against existing entities: removes those no longer present, creates new ones,
-- updates train-stop properties on existing ones.
---@param json string JSON object with tile_x, tile_y, tile_size, entities[]
function rail_sync_manager.apply_rail_entities(json)
	local data = helpers.json_to_table(json) --[[@as {tile_x:number,tile_y:number,tile_size:number,entities:table[]}]]
	if data == nil then
		log("[gridworld] apply_rail_entities: failed to parse JSON")
		return
	end
	if data.tile_x == nil or data.tile_y == nil or data.tile_size == nil then
		log("[gridworld] apply_rail_entities: missing tile_x/tile_y/tile_size in payload")
		return
	end

	local half = data.tile_size / 2
	local center_x = data.tile_x * data.tile_size
	local center_y = data.tile_y * data.tile_size
	local area = {
		left_top     = { x = center_x - half, y = center_y - half },
		right_bottom = { x = center_x + half, y = center_y + half },
	}

	-- Build a lookup key for each source entity.
	local function entity_key(e)
		return (e.surface or "nauvis") .. ":" .. e.x .. "," .. e.y .. "," .. e.direction .. "," .. e.name
	end

	-- Index source entities by key.
	local source_map = {}
	for _, e in ipairs(data.entities) do
		source_map[entity_key(e)] = e
	end

	-- Walk existing pathworld entities in the tile area.
	for _, surface in pairs(game.surfaces) do
		local existing = surface.find_entities_filtered { area = area }
		for _, entity in ipairs(existing) do
			if entity.valid and rail_sync_manager.RAIL_TYPES[entity.type] and not rail_sync_manager.UE_PROTECTED_NAMES[entity.name] then
				local key = surface.name .. ":" .. entity.position.x .. "," .. entity.position.y .. "," .. entity.direction .. "," .. entity.name
				local src = source_map[key]
				if src == nil then
					-- No longer present in source tile — remove.
					entity.destroy()
				else
					-- Entity matches — update train-stop properties if applicable.
					if entity.type == "train-stop" then
						if src.stopName ~= nil then entity.backer_name = src.stopName end
						if src.priority ~= nil then entity.train_stop_priority = src.priority end
						if src.trainLimit == nil then
							-- nil in source means unlimited
							entity.trains_limit = nil
						else
							-- Clamp: available capacity = limit - current trains on source
							local count = src.trainCount or 0
							entity.trains_limit = math.max(0, src.trainLimit - count)
						end
					end
					-- Mark as handled so we don't create a duplicate.
					source_map[key] = nil
				end
			end
		end
	end

	-- Create entities that are in the source but not yet on the pathworld.
	local created = 0
	local failed = 0
	for _, src in pairs(source_map) do
		local surface = game.surfaces[src.surface] or game.surfaces["nauvis"]
		if surface then
			local ok, err = pcall(function()
				surface.create_entity {
					name      = src.name,
					position  = { x = src.x, y = src.y },
					direction = src.direction,
					force     = game.forces.player,
				}
			end)
			if ok then
				created = created + 1
			else
				failed = failed + 1
				log("[gridworld] apply_rail_entities: failed to create " .. src.name .. " at " .. src.x .. "," .. src.y .. ": " .. tostring(err))
			end
		end
	end
	-- log("[gridworld] apply_rail_entities: tile=" .. data.tile_x .. "," .. data.tile_y .. " created=" .. created .. " failed=" .. failed)
end

-- Apply ue_source_trainstop entities sent from all source instances onto this pathworld.
-- The payload contains every UE stop reported by one source tile.
-- We diff the entire pathworld's set of ue_source_trainstop entities against the
-- cumulative list: remove those no longer reported by any tile, add new ones.
-- Storage tracks which stops were last reported per source tile so removals are precise.
---@param json string JSON object with tile_x, tile_y, stops[]
function rail_sync_manager.apply_ue_stops(json)
	local data = helpers.json_to_table(json) --[[@as {tile_x:number,tile_y:number,stops:table[]}]]
	if data == nil then
		log("[gridworld] apply_ue_stops: failed to parse JSON")
		return
	end

	-- Persist this tile's stops so we have the full picture across all tiles.
	if storage.gridworld_ue_stops == nil then
		storage.gridworld_ue_stops = {}
	end
	local tile_key = tostring(data.tile_x) .. "," .. tostring(data.tile_y)
	storage.gridworld_ue_stops[tile_key] = data.stops

	-- Build a flat source map from ALL tiles combined.
	local function stop_key(s)
		return (s.surface or "nauvis") .. ":" .. s.x .. "," .. s.y .. "," .. s.direction
	end

	local source_map = {}
	for _, stops in pairs(storage.gridworld_ue_stops) do
		for _, s in ipairs(stops) do
			source_map[stop_key(s)] = s
		end
	end

	-- Diff existing pathworld ue_source_trainstop entities against the combined source.
	for _, surface in pairs(game.surfaces) do
		local existing = surface.find_entities_filtered { name = "ue_source_trainstop" }
		for _, entity in ipairs(existing) do
			if entity.valid then
				local key = surface.name .. ":" .. entity.position.x .. "," .. entity.position.y .. "," .. entity.direction
				local src = source_map[key]
				if src == nil then
					-- No longer reported by any source — remove.
					entity.destroy()
				else
					-- Present — sync backer_name if it changed.
					if src.stopName ~= nil and entity.backer_name ~= src.stopName then
						entity.backer_name = src.stopName
					end
					source_map[key] = nil
				end
			end
		end
	end

	-- Create stops that exist in sources but not yet on the pathworld.
	local created = 0
	local failed = 0
	for _, src in pairs(source_map) do
		local surface = game.surfaces[src.surface] or game.surfaces["nauvis"]
		if surface then
			local ok, err = pcall(function()
				local entity = surface.create_entity {
					name      = "ue_source_trainstop",
					position  = { x = src.x, y = src.y },
					direction = src.direction,
					force     = game.forces.player,
				}
				if entity and src.stopName ~= nil then
					entity.backer_name = src.stopName
				end
			end)
			if ok then
				created = created + 1
			else
				failed = failed + 1
				log("[gridworld] apply_ue_stops: failed to create ue_source_trainstop at " .. src.x .. "," .. src.y .. ": " .. tostring(err))
			end
		end
	end
	-- log("[gridworld] apply_ue_stops: tile=" .. data.tile_x .. "," .. data.tile_y .. " created=" .. created .. " failed=" .. failed)
end

return rail_sync_manager
