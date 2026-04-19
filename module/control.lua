local clusterio_api = require("modules/clusterio/api")
local rail_sync_manager = require("modules/gridworld/rail_sync_manager")
local train_path_manager = require("modules/gridworld/train_path_manager")
local time_sync_manager = require("modules/gridworld/time_sync_manager")
local corner_scanner = require("modules/gridworld/corner_scanner")
local universal_serializer = require("modules/universal_edges/universal_serializer/universal_serializer")
local ue_hooks = require("modules/universal_edges/universal_serializer/hooks")

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
	if not storage.gridworld.corner_neighbors then
		storage.gridworld.corner_neighbors = {}
	end
	if not storage.gridworld.players_waiting_to_leave_diagonal then
		storage.gridworld.players_waiting_to_leave_diagonal = {}
	end
	if not storage.gridworld.players_waiting_to_join_diagonal then
		storage.gridworld.players_waiting_to_join_diagonal = {}
	end
	if not storage.gridworld.diagonal_vehicle_drivers then
		storage.gridworld.diagonal_vehicle_drivers = {}
	end
	if not storage.gridworld.diagonal_vehicle_passengers then
		storage.gridworld.diagonal_vehicle_passengers = {}
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

---@param json string
function gridworld.set_corner_neighbors(json)
	ensure_storage()
	local data = helpers.json_to_table(json)
	if data then
		storage.gridworld.corner_neighbors = data
	end
end

---@param player_name string
---@param address string
---@param server_name string|nil
---@param direction string|nil
function gridworld.corner_teleport_response(player_name, address, server_name, direction)
	if player_name == nil or address == nil then return end
	local player = game.players[player_name]
	if player == nil then
		log("[gridworld] Corner teleport failed: Player " .. player_name .. " not found")
		return
	end
	player.connect_to_server({
		address = address,
		name = (server_name or "unknown"),
		description = "server to the " .. (direction or "unknown"),
	})
end

---@param json string
function gridworld.receive_diagonal_entity(json)
	ensure_storage()
	local data = helpers.json_to_table(json)
	if data == nil then return end
	local entity_transfers = data.entity_transfers
	if entity_transfers == nil then return end

	for _, transfer in ipairs(entity_transfers) do
		if transfer.type == "player" then
			storage.gridworld.players_waiting_to_join_diagonal[transfer.player_name] = {
				world_position = transfer.world_position,
			}
		elseif transfer.type == "vehicle" then
			-- Fix position format after JSON round-trip (Lua arrays become {"1":x,"2":y})
			local pos = transfer.serialized_entity.position
			if pos then
				transfer.serialized_entity.position = { x = pos[1] or pos["1"], y = pos[2] or pos["2"] }
			end
			local entity = universal_serializer.LuaEntity.deserialize(transfer.serialized_entity)
			if transfer.driver_name and entity and entity.valid then
				storage.gridworld.diagonal_vehicle_drivers[transfer.driver_name] = entity
			end
			if transfer.passenger_name and entity and entity.valid then
				storage.gridworld.diagonal_vehicle_passengers[transfer.passenger_name] = entity
			end
		end
	end
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

gridworld.on_nth_tick[90] = function()
	corner_scanner.poll_corners()
end

gridworld.events[defines.events.on_player_joined_game] = function(event)
	ensure_storage()
	corner_scanner.on_player_joined_game(event)
end

gridworld.events[defines.events.on_player_left_game] = function(event)
	ensure_storage()
	corner_scanner.on_player_left_game(event)
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

-- Serialization hooks for universal_edges train transfer

-- Clear pending train path request before a train is serialized for edge transfer
ue_hooks.register("LuaTrainComplete", "pre_serialize", function(_data, context)
	local LuaTrain = context.LuaTrain
	if not LuaTrain or not LuaTrain.valid then return end
	local train_id = LuaTrain.front_stock.unit_number
	local pending = storage.gridworld and storage.gridworld.train_path_requests
		and storage.gridworld.train_path_requests[train_id]
	if not pending then return end
	if pending.render and pending.render.valid then pending.render.destroy() end
	storage.gridworld.train_path_requests[train_id] = nil
	clusterio_api.send_json("gridworld:clear_train_path_request", { id = train_id })
end)

-- Remove the current schedule record if it matches the source trainstop we're departing from
ue_hooks.register("LuaTrain", "post_serialize", function(train_data, context)
	local edge = context.edge
	local offset = context.offset
	local train = context.train

	if edge and offset and train_data.schedule and train_data.schedule.records then
		local stop_name = edge.id .. " " .. offset
		local record = train_data.schedule.records[train_data.schedule.current]
		if record and record.station and record.station == stop_name then
			local new_schedule = table.deepcopy(train_data.schedule)
			table.remove(new_schedule.records, new_schedule.current)
			train_data.schedule = new_schedule
			-- log("Modified schedule - current: " .. new_schedule.current .. " records: " .. serpent.block(new_schedule.records))
		end
	end
	return train_data
end)

-- Destroy train pathing proxy for the arriving train's destination BEFORE the train is spawned.
-- This must run in pre_deserialize (not post_deserialize) to remove the proxy before Factorio
-- evaluates the new train's schedule and sees the station as full.
ue_hooks.register("LuaTrainComplete", "pre_deserialize", function(train_data, _context)
	local proxies = storage.gridworld and storage.gridworld.train_proxies
	if not proxies then return end

	local schedule = train_data.train and train_data.train.schedule
	if not schedule or not schedule.records then return end

	local record = schedule.records[schedule.current]
	local destination = record and record.station
	if not destination or not proxies[destination] or #proxies[destination] == 0 then return end

	local loco = table.remove(proxies[destination])
	if loco and loco.valid then
		loco.destroy()
	else
		log("Failed to destroy train proxy for destination " .. destination .. " - invalid entity")
	end
	if #proxies[destination] == 0 then
		proxies[destination] = nil
	end
end)

return gridworld
