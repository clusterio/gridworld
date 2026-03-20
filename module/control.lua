local clusterio_api = require("modules/clusterio/api")
local rail_sync_manager = require("modules/gridworld/rail_sync_manager")
local train_path_manager = require("modules/gridworld/train_path_manager")
local time_sync_manager = require("modules/gridworld/time_sync_manager")

local gridworld = {
	events = {},
	on_nth_tick = {},
}

local function ensure_storage()
	if storage.gridworld == nil then
		storage.gridworld = {
			tile_x = nil,
			tile_y = nil,
			tile_size = nil,
			surface_name = nil,
			bounds = nil,
			is_pathworld = false,
			train_path_requests = {},
			train_proxies = {},
		}
	end
	if not storage.gridworld.train_proxies then
		storage.gridworld.train_proxies = {}
	end
end

local function update_bounds()
	local config = storage.gridworld
	if config.tile_x == nil or config.tile_y == nil or config.tile_size == nil then
		config.bounds = nil
		return
	end
	local half = config.tile_size / 2
	local center_x = config.tile_x * config.tile_size
	local center_y = config.tile_y * config.tile_size
	config.bounds = {
		min_x = center_x - half,
		max_x = center_x + half,
		min_y = center_y - half,
		max_y = center_y + half,
	}
end

function gridworld.set_config(config)
	if config == nil then
		return
	end
	ensure_storage()
	storage.gridworld.tile_x = config.tile_x
	storage.gridworld.tile_y = config.tile_y
	storage.gridworld.tile_size = config.tile_size
	storage.gridworld.surface_name = config.surface_name
	update_bounds()
end

function gridworld.set_pathworld()
	ensure_storage()
	storage.gridworld.is_pathworld = true
	log("[gridworld] this instance is pathworld; on_chunk_generated will clear entities and decoratives")
end

--- Called on the pathworld instance via RCON to generate and chart chunks
--- for all known gridworld tile areas.
---@param json string JSON array of {minX, maxX, minY, maxY, surfaceName} objects
function gridworld.sync_tile_areas(json)
	local tiles = helpers.json_to_table(json) --[[@as {minX:number,maxX:number,minY:number,maxY:number,surfaceName:string}[] ]]
	if tiles == nil then
		log("[gridworld] sync_tile_areas: failed to parse JSON")
		return
	end
	for _, tile in ipairs(tiles) do
		local surface = game.surfaces[tile.surfaceName]
		if surface == nil then
			log("[gridworld] sync_tile_areas: surface not found: " .. tostring(tile.surfaceName))
			goto continue
		end
		local chunk_size = 32
		local cx_min = math.floor(tile.minX / chunk_size)
		local cx_max = math.floor((tile.maxX - 1) / chunk_size)
		local cy_min = math.floor(tile.minY / chunk_size)
		local cy_max = math.floor((tile.maxY - 1) / chunk_size)
		for cx = cx_min, cx_max do
			for cy = cy_min, cy_max do
				surface.request_to_generate_chunks({ x = cx * chunk_size, y = cy * chunk_size }, 0)
			end
		end
		-- Entity/decorative removal is handled by on_chunk_generated in pathworld mode.
		game.forces.player.chart(surface, {
			left_top     = { x = tile.minX, y = tile.minY },
			right_bottom = { x = tile.maxX, y = tile.maxY },
		})
		::continue::
	end
end

local function is_outside_bounds(position, bounds)
	return position.x < bounds.min_x
		or position.x > bounds.max_x
		or position.y < bounds.min_y
		or position.y > bounds.max_y
end

local function should_check_entity(entity)
	if entity == nil or not entity.valid then
		return false
	end
	local config = storage.gridworld
	if config == nil or config.bounds == nil then
		return false
	end
	if config.surface_name and entity.surface and entity.surface.name ~= config.surface_name then
		return false
	end
	if entity.type == "character" then
		return false
	end
	return true
end

local function destroy_if_outside(entity)
	if not should_check_entity(entity) then
		return
	end
	-- UE source stops sit outside tile bounds intentionally — never destroy them.
	if rail_sync_manager.UE_PROTECTED_NAMES[entity.name] then
		return
	end
	if is_outside_bounds(entity.position, storage.gridworld.bounds) then
		entity.destroy()
	end
end

gridworld.events[clusterio_api.events.on_server_startup] = function(_event)
	ensure_storage()
	update_bounds()
end

gridworld.events[defines.events.on_train_changed_state] = function(event)
	train_path_manager.on_train_changed_state(event)
end

gridworld.events[defines.events.on_train_schedule_changed] = function(event)
	train_path_manager.on_train_schedule_changed(event)
end

gridworld.on_nth_tick[300] = function()
	if clusterio_api.get_instance_name() == "pathworld" then
		train_path_manager.process_path_queue()
	end
end

gridworld.on_nth_tick[900] = function()
	rail_sync_manager.collect_and_send_rail_entities()
	rail_sync_manager.collect_and_send_ue_stops()
end

gridworld.on_nth_tick[3600] = function()
	time_sync_manager.check_convergence()
end

gridworld.events[defines.events.on_entity_spawned] = function(event)
	destroy_if_outside(event.entity)
end

gridworld.events[defines.events.on_biter_base_built] = function(event)
	destroy_if_outside(event.entity)
end

gridworld.events[defines.events.on_built_entity] = function(event)
	destroy_if_outside(event.entity)
end

gridworld.events[defines.events.on_robot_built_entity] = function(event)
	destroy_if_outside(event.entity)
end

gridworld.events[defines.events.script_raised_revive] = function(event)
	destroy_if_outside(event.entity)
end

gridworld.events[defines.events.on_chunk_generated] = function(event)
	if storage.gridworld == nil then
		return
	end
	local surface = event.surface
	local config = storage.gridworld
	local area = event.area

	if config.is_pathworld then
		local entities = surface.find_entities_filtered { area = area }
		for _, entity in ipairs(entities) do
			if entity.valid and entity.type ~= "character" and not rail_sync_manager.RAIL_TYPES[entity.type]
				and not rail_sync_manager.UE_PROTECTED_NAMES[entity.name] then
				entity.destroy()
			end
		end
		surface.destroy_decoratives { area = area }
		return
	end

	-- Normal tile mode: destroy entities outside this tile's bounds.
	if config.bounds == nil then
		return
	end
	if config.surface_name and surface.name ~= config.surface_name then
		return
	end
	local bounds = config.bounds
	if area.left_top.x >= bounds.min_x
		and area.right_bottom.x <= bounds.max_x
		and area.left_top.y >= bounds.min_y
		and area.right_bottom.y <= bounds.max_y
	then
		return
	end

	local entities = surface.find_entities_filtered { area = area }
	for _, entity in ipairs(entities) do
		if entity.valid and entity.type ~= "character" then
			if not rail_sync_manager.UE_PROTECTED_NAMES[entity.name] and is_outside_bounds(entity.position, bounds) then
				entity.destroy()
			end
		end
	end
end

return gridworld
