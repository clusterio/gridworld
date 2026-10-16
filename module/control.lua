-- Gridworld v2 module entry (SP2 spec §4): migrations, the event handlers and gw.selfcheck. GW registers no on_tick:
-- its periodic work runs on UE's scheduler.
local clusterio_api = require("modules/clusterio/api")
local ue = require("modules/universal_edges")
if ue.api_version ~= 1 then
	error("gridworld 4.0.0 needs universal_edges Lua API version 1, found " .. tostring(ue.api_version))
end
local runtime = ue.runtime

runtime.migrations.register("gridworld", require("modules/gridworld/schema_core"))

local tile = require("modules/gridworld/tile")
require("modules/gridworld/zones")
require("modules/gridworld/evolution") -- cross-border biters spec §8: its report task and apply handler
local send = runtime.bridge.channel("gridworld")

-- SP0's self-check, now carrying the day sync's counters and the cleanup backlog (§11.4); the counters restart after
-- each report.
runtime.scheduler.periodic{
	name = "gw.selfcheck",
	interval = 3600,
	fn = function(tick)
		local s = storage.gridworld
		local backlog = 0
		for _ in pairs(s.cleanup) do
			backlog = backlog + 1
		end
		send("trace", {
			op = "gw.selfcheck", phase = "done", level = "verbose", tick = tick, schema = s.schema, syncs = s.stats.syncs,
			snaps = s.stats.snaps, max_drift = s.stats.max_drift, cleanup = backlog,
		})
		s.stats.syncs, s.stats.snaps, s.stats.max_drift = 0, 0, 0
	end,
}

local control = { events = {} }
control.events[clusterio_api.events.on_server_startup] = tile.on_server_startup
control.events[defines.events.on_chunk_generated] = tile.on_chunk_generated
-- §9.4: player and robot builds only; script builds (script_raised_built, _revive) belong to the script that made them.
control.events[defines.events.on_built_entity] = tile.on_built_entity
control.events[defines.events.on_robot_built_entity] = tile.on_robot_built_entity
control.events[defines.events.on_biter_base_built] = tile.on_enemy
control.events[defines.events.on_entity_spawned] = tile.on_enemy
-- No player handler: gridworld doesn't move players; crossing is UE's, with gridworld's corner zones as its hook
-- (player-crossing spec §7.1, crossing-arrival spec §4).

return control
