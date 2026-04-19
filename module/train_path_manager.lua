local clusterio_api = require("modules/clusterio/api")
local edge_util = require("modules/universal_edges/edge/util")

local tpm = {}

local TRAIN_STATE_NAMES = {}
for name, id in pairs(defines.train_state) do
    TRAIN_STATE_NAMES[id] = name
end

local HANDLED_TRAIN_STATES = {
    [defines.train_state.wait_station] = true,
    [defines.train_state.destination_full] = true,
    [defines.train_state.no_path] = true,
}

-- TODO: unreachable paths should be handled somehow. right now the train complains of destination full because of the edge stop

--------------------------------------------------------------------------------------------------
-- Source Instance
--------------------------------------------------------------------------------------------------

function tpm.on_train_schedule_changed(event)
    local LuaTrain = event.train
    local train_id = LuaTrain.front_stock.unit_number
    -- skip if we're applying a path result (we change the schedule ourselves)
    if storage.gridworld._applying_path == train_id then return end
    storage.gridworld.train_path_requests[train_id] = nil
    clusterio_api.send_json("gridworld:clear_train_path_request", { id = train_id })
end

function tpm.on_train_changed_state(event)
    local old_state = event.old_state
    local LuaTrain = event.train
    local new_state = LuaTrain.state
    local train_id = LuaTrain.front_stock.unit_number
    local is_spawning = storage.universal_edges.delayed_entities
        and storage.universal_edges.delayed_entities[train_id]

    -- Rule 1: ignore spawn-cycle transitions (UE carriage add/restore always goes through manual_control)
    if is_spawning
        and (old_state == defines.train_state.manual_control
            or new_state == defines.train_state.manual_control)
    then
        return
    end

    -- Rule 2: manual mode (not spawning) — cleanup
    if new_state == defines.train_state.manual_control then
        local pending = storage.gridworld.train_path_requests[train_id]
        if pending then
            if pending.render and pending.render.valid then
                pending.render.destroy()
            end
            storage.gridworld.train_path_requests[train_id] = nil
            clusterio_api.send_json("gridworld:clear_train_path_request", { id = train_id })
        end
        tpm.notify_proxy_removal(LuaTrain)
        tpm.remove_temporary_schedule_stops(LuaTrain)
        return
    end

    -- Rule 3: skip if current record is a temp edge waypoint we inserted
    local schedule = LuaTrain.schedule
    local current_record = schedule and schedule.records and schedule.records[schedule.current]
    local current_station = current_record and current_record.station
    local is_gridworld_stop = current_station and string.find(current_station, "gridworld:", 1, true)
    if current_record and current_record.temporary and is_gridworld_stop then return end

    -- Rule 4: skip if request already pending or path already applied
    if storage.gridworld.train_path_requests[train_id] then return end

    -- Rules 5 & 6: request cross-tile path
    if old_state == defines.train_state.manual_control
        and new_state == defines.train_state.destination_full
    then
        tpm.request_train_path(LuaTrain)
    elseif HANDLED_TRAIN_STATES[old_state] then
        tpm.request_train_path(LuaTrain)
    end
end

---@param LuaTrain LuaTrain
function tpm.request_train_path(LuaTrain)
    -- Implementation for requesting a train path
    -- skip if train is already in manual mode (e.g., request already in progress)
    if LuaTrain.manual_mode then return end
    -- get current train schedule target
    local schedule = LuaTrain.schedule
    local current_record = schedule and schedule.records and schedule.records[schedule.current]
    if not current_record or not current_record.station then return end
    local destination = current_record.station
    local front_stock = LuaTrain.front_stock
    local train_id = front_stock.unit_number
    local front_end = LuaTrain.front_end
    if not front_end then return end
    -- skip if a request is already in-flight for this train
    if storage.gridworld.train_path_requests[train_id] then return end
    -- add request to globals
    storage.gridworld.train_path_requests[train_id] = {
        front_stock = LuaTrain.front_stock,
        is_pathing = true,
    }
    local rail_pos = front_end.rail.position
    local path_request = { ---@class TrainPathRequest
        id = train_id,
        surface = front_stock.surface.name,
        position = { x = rail_pos.x, y = rail_pos.y },
        direction = front_stock.direction,
        destination = destination,
        sourceInstanceId = nil, -- added by typescript
    }
    -- add status text to train
    local render = rendering.draw_text{
        text = "Requesting path",
        surface = front_stock.surface,
        target = front_stock,
        color = { r = 1, g = 1, b = 1, a = 1 },
        blink_interval = 30,
        alignment = "center",
        vertical_alignment = "middle",
    }
    storage.gridworld.train_path_requests[train_id].render = render
    -- send the request to the controller
    clusterio_api.send_json("gridworld:request_train_path", path_request)
end

-- called from rcon by the Clusterio Controller
function tpm.apply_train_path_result(json)
    -- Implementation for applying a train path
    -- convert json
    local path_result = helpers.json_to_table(json)
    if not path_result then return end
    -- apply the path to the train schedule
    if not storage.gridworld.train_path_requests[path_result.id] then
        game.print("[gridworld:tpm] No pending train path request found for train id: " .. path_result.id)
        log("[gridworld:tpm] No pending train path request found for train id: " .. path_result.id)
        return
    end
    local pending = storage.gridworld.train_path_requests[path_result.id]
    local front_stock = pending.front_stock
    if not front_stock or not front_stock.valid then
        if pending.render and pending.render.valid then pending.render.destroy() end
        storage.gridworld.train_path_requests[path_result.id] = nil
        return
    end
    local LuaTrain = front_stock.train
    if #path_result.path == 0 then
        -- no path found, re-enable train and let it retry naturally
        -- LuaTrain.manual_mode = false
        if pending.render and pending.render.valid then pending.render.destroy() end
        storage.gridworld.train_path_requests[path_result.id] = nil
        return
    end

    -- If the train is outside our tile bounds (just arrived from an edge crossing), the pathworld
    -- includes the entry edge stop as the first hop since its starting rail is past that stop.
    -- Skip it — the train already traversed that edge.
    local path = path_result.path
    local bounds = storage.gridworld.bounds
    if bounds and #path > 0 and tpm.is_edge_stop(path[1]) then
        local pos = LuaTrain.front_stock.position
        if pos.x < bounds.min_x or pos.x > bounds.max_x or pos.y < bounds.min_y or pos.y > bounds.max_y then
            table.remove(path, 1)
        end
    end
    if #path == 0 then
        if pending.render and pending.render.valid then pending.render.destroy() end
        storage.gridworld.train_path_requests[path_result.id] = nil
        return
    end

    -- insert ue_source_trainstop names as temporary schedule records before the current destination
    local lua_schedule = LuaTrain.get_schedule()
    local insert_index = lua_schedule.current
    -- suppress on_train_schedule_changed from clearing the pending entry
    storage.gridworld._applying_path = path_result.id
    for i, stop_name in ipairs(path) do
        lua_schedule.add_record{
            station = stop_name,
            temporary = true,
            index = { schedule_index = insert_index + i - 1 },
        }
    end
    -- point to the first temporary stop so the train paths there
    lua_schedule.go_to_station(insert_index)
    storage.gridworld._applying_path = nil
    LuaTrain.manual_mode = false
    -- remove train status text
    if pending.render and pending.render.valid then pending.render.destroy() end
    -- keep pending entry so spawn-cycling and repeated state changes don't re-request;
    -- cleared by manual_control cleanup (rule 2) or external schedule change
end

function tpm.remove_temporary_schedule_stops(LuaTrain)
    local lua_schedule = LuaTrain.get_schedule()
    if not lua_schedule then return end
    local records = lua_schedule.get_records()
    if not records then return end
    -- Remove in reverse order so indices stay valid
    for i = #records, 1, -1 do
        if records[i].temporary and tpm.is_edge_stop(records[i].station) then
            lua_schedule.remove_record{ schedule_index = i }
        end
    end
end

function tpm.notify_proxy_removal(LuaTrain)
    local schedule = LuaTrain.schedule
    if not schedule or not schedule.records then return end
    local records = schedule.records
    for i = #records, 1, -1 do
        if records[i].temporary then
            local dest_record = records[i + 1]
            if not dest_record then return end
            clusterio_api.send_json("gridworld:remove_train_proxy", {
                last_edge_stop = records[i].station,
                destination = dest_record.station,
            })
            return
        end
    end
    -- no edge stops found, nothing to send
end

-- called from rcon by the Clusterio Controller to clean up proxy trains when a path is cancelled
function tpm.remove_train_proxies(json)
    local data = helpers.json_to_table(json)
    if not data then return end
    local proxies = storage.gridworld.train_proxies[data.destination]
    if not proxies then return end
    for i = #proxies, 1, -1 do
        if not proxies[i].valid then
            table.remove(proxies, i)
        else
            proxies[i].destroy()
            table.remove(proxies, i)
            return
        end
    end
end

--- Check if a station name is an edge connector (e.g., "gridworld:-1,0:-1,1 199")
function tpm.is_edge_stop(station_name)
    if not station_name then return false end
    return station_name:match("^gridworld:.+ %d+$") ~= nil
end

--------------------------------------------------------------------------------------------------
-- Pathworld
--------------------------------------------------------------------------------------------------

-- called from rcon by the Clusterio Controller
function tpm.find_train_path(json)
    -- Implementation for finding a train path
    -- convert json
    local path_request = helpers.json_to_table(json)
    if not path_request then return end
    assert(type(path_request) == "table")
    -- clear any stale queued retry for this train before processing
    storage.gridworld.train_path_requests[path_request.id] = nil
    tpm.process_path_request(path_request)
end

tpm.RAIL_TYPES = {
    "straight-rail",
    "curved-rail-a",
    "curved-rail-b",
    "half-diagonal-rail",
    "legacy-straight-rail",
    "legacy-curved-rail",
    "elevated-straight-rail",
    "elevated-curved-rail-a",
    "elevated-curved-rail-b",
    "elevated-half-diagonal-rail",
    "rail-ramp",
}

---@param path_request TrainPathRequest
function tpm.process_path_request(path_request)
    local path = {
        id = path_request.id,
        path = {},
        source_instance_id = path_request.sourceInstanceId,
    }
    -- find stations
    local surface = game.surfaces[path_request.surface]
    if not surface then
        game.print("[gridworld:tpm] Surface not found: " .. path_request.surface)
        log("[gridworld:tpm] Surface not found: " .. path_request.surface)
        tpm.return_train_path_result(path) -- empty path
        return
    end
    local all_stops = surface.find_entities_filtered{ type = "train-stop" }
    -- filter stations
    local goals = {}
    for _, stop in ipairs(all_stops) do
        if stop.valid and stop.backer_name == path_request.destination and stop.trains_limit ~= 0 then
            table.insert(goals, { train_stop = stop })
        end
    end
    if #goals == 0 then
        game.print("[gridworld:tpm] No valid train stops found for destination: " .. path_request.destination .. " (queued for retry)")
        log("[gridworld:tpm] No valid train stops found for destination: " .. path_request.destination .. " — queuing for retry")
        tpm.queue_path_request(path_request)
        return
    end
    -- find starting rail (may be straight or curved)
    local start_rails = surface.find_entities_filtered{
        type = tpm.RAIL_TYPES,
        position = path_request.position,
        radius = 2,
    }
    if #start_rails == 0 then
        game.print("[gridworld:tpm] No starting rail found near position: " .. path_request.position.x .. ", " .. path_request.position.y)
        log("[gridworld:tpm] No starting rail found near position: " .. path_request.position.x .. ", " .. path_request.position.y)
        tpm.return_train_path_result(path)
        return
    end
    local start_rail = start_rails[1]
    -- render line from source to each goal station
    local ttl = 300 -- 5 seconds at 60 ticks/s
    for _, goal in ipairs(goals) do
        rendering.draw_line{
            color = { r = 0.5, g = 0.5, b = 0.5, a = 0.5 },
            width = 2,
            from = start_rail,
            to = goal.train_stop,
            surface = surface,
            time_to_live = ttl,
            draw_on_ground = true,
        }
    end
    -- find path
    local result = game.train_manager.request_train_path{
        starts = {
            { rail = start_rail, direction = defines.rail_direction.front },
            { rail = start_rail, direction = defines.rail_direction.back },
        },
        goals = goals,
        return_path = true,
    }
    if not result.found_path or not result.path then
        game.print("[gridworld:tpm] No path found for train id: " .. path_request.id .. " (queued for retry)")
        log("[gridworld:tpm] No path found for train id: " .. path_request.id .. " — queuing for retry")
        tpm.queue_path_request(path_request)
        return
    end
    -- highlight the chosen goal
    rendering.draw_line{
        color = { r = 0, g = 1, b = 0, a = 0.8 },
        width = 4,
        from = start_rail,
        to = goals[result.goal_index].train_stop,
        surface = surface,
        time_to_live = ttl,
        draw_on_ground = true,
    }
    -- adjust_pathworld_station_limit
    local station = goals[result.goal_index].train_stop
    station.trains_limit = math.max(0, (station.trains_limit or 0) - 1)
    -- iterate path for ue_source_trainstop, drawing a line between each consecutive rail
    local seen = {}
    local prev_rail = start_rail
    for _, rail in ipairs(result.path) do
        if rail.valid then
            rendering.draw_line{
                color = { r = 1, g = 0.8, b = 0, a = 0.7 },
                width = 2,
                from = prev_rail,
                to = rail,
                surface = surface,
                time_to_live = ttl,
                draw_on_ground = true,
            }
            prev_rail = rail
            for _, rail_dir in ipairs({ defines.rail_direction.front, defines.rail_direction.back }) do
                local stop = rail.get_rail_segment_stop(rail_dir)
                if stop and stop.valid and stop.name == "ue_source_trainstop" and not seen[stop.backer_name] then
                    seen[stop.backer_name] = true
                    table.insert(path.path, stop.backer_name)
                    rendering.draw_circle{
                        color = { r = 0, g = 0.6, b = 1, a = 0.9 },
                        radius = 2,
                        width = 3,
                        filled = false,
                        target = stop,
                        surface = surface,
                        time_to_live = ttl,
                        draw_on_ground = true,
                    }
                end
            end
        end
    end
    -- remove queued path request (if it exists)
    storage.gridworld.train_path_requests[path_request.id] = nil
    -- return path to controller
    tpm.return_train_path_result(path)
end

---@param path table
function tpm.return_train_path_result(path)
    -- Implementation for returning a train path
    -- send result to controller
    clusterio_api.send_json("gridworld:return_train_path", path)
end

--------------------------------------------------------------------------------------------------
-- Pathworld Helpers
--------------------------------------------------------------------------------------------------

function tpm.queue_path_request(path_request)
    storage.gridworld.train_path_requests[path_request.id] = path_request
end

function tpm.process_path_queue()
    -- Snapshot keys first; process_path_request modifies the table (deletes on success, re-inserts on failure)
    local requests = {}
    for id, request in pairs(storage.gridworld.train_path_requests) do
        requests[id] = request
    end
    for _, request in pairs(requests) do
        tpm.process_path_request(request)
    end
end

-- proxy train creation on destination when a path request is returned
function tpm.create_train_proxy(json)
    local data = helpers.json_to_table(json)
    if not data then return end

    local destination = data.destination
    local edge_id = data.edge_id
    local offset = data.offset

    -- Find the destination connector rails from universal_edges storage
    local edge = storage.universal_edges and storage.universal_edges.edges and storage.universal_edges.edges[edge_id]
    if not edge then
        log("[gridworld:tpm] create_train_proxy: edge not found: " .. tostring(edge_id))
        return
    end
    local link = edge.linked_trains and edge.linked_trains[offset]
    if not link then
        log("[gridworld:tpm] create_train_proxy: train link not found at offset " .. tostring(offset) .. " for edge " .. tostring(edge_id))
        return
    end
    if link.is_input then
        log("[gridworld:tpm] create_train_proxy: refusing to create proxy at is_input link (offset " .. tostring(offset) .. " edge " .. tostring(edge_id) .. ") — proxy should only be created at destination (is_input=false) links")
        return
    end
    local rail = link.rails and link.rails[#link.rails - 1]
    if not rail or not rail.valid then
        log("[gridworld:tpm] create_train_proxy: no valid rail at offset " .. tostring(offset) .. " for edge " .. tostring(edge_id))
        return
    end

    -- edge_target.direction points outward (toward the edge border)
    -- The proxy needs to face inward (toward the station), so flip by 180 degrees
    local edge_target = edge_util.edge_get_local_target(edge)
    local inward_direction = (edge_target.direction + 8) % 16

    -- Spawn a single locomotive on the enemy force at the destination connector
    local loco = rail.surface.create_entity{
        name = "locomotive",
        position = rail.position,
        direction = inward_direction,
        force = "enemy",
    }
    if not loco then
        log("[gridworld:tpm] create_train_proxy: failed to create proxy locomotive")
        return
    end

    -- Set schedule targeting the destination station and switch to automatic mode
    local train = loco.train
    if train then
        train.schedule = {
            current = 1,
            records = {
                {
                    station = destination,
                },
            },
        }
        train.manual_mode = false
    end

    -- Store proxy keyed by station name
    if not storage.gridworld.train_proxies[destination] then
        storage.gridworld.train_proxies[destination] = {}
    end
    table.insert(storage.gridworld.train_proxies[destination], loco)
end

-- called from rcon by the Clusterio Controller to cancel a pending path request
function tpm.clear_train_path_request(json)
    local data = helpers.json_to_table(json)
    if not data then return end
    storage.gridworld.train_path_requests[data.id] = nil
end

return tpm