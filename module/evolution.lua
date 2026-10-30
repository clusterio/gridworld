-- Shared evolution per planet (cross-border biters spec §8): every 60 s each tile reports what its pollution and spawner-
-- kill parts grew by since its last report; the controller sums them, advances the time part once for the cluster, and
-- sends the three parts back, which every tile sets. Off while map_settings.enemy_evolution.enabled is false, and while
-- the shared_evolution toggle is off: each planet's evolution then runs as vanilla's from where it is.
-- storage.gridworld.evolution[surface] = { pollution, kills }: the parts as this tile last reported or applied them.
local ue = require("modules/universal_edges")
local tile = require("modules/gridworld/tile")
local border_core = require("modules/gridworld/border_core")

local evolution = {}
local send = ue.runtime.bridge.channel("gridworld")

--- Spec §8's report, per planet surface this tile has: its time part (the controller takes it for a planet it hasn't
--- seen), and its pollution and kill parts' growth since the last report or apply.
function evolution.report()
	local s = storage.gridworld
	local ev = game.map_settings.enemy_evolution
	if not (s.configured and ev.enabled and border_core.on(s.toggles, "shared_evolution")) then
		return
	end
	local force, planets = game.forces.enemy, {}
	for name in pairs(s.tiles) do
		local surface = game.get_surface(name)
		if surface then
			local last = s.evolution[name] or { pollution = 0, kills = 0 }
			local p = force.get_evolution_factor_by_pollution(surface)
			local k = force.get_evolution_factor_by_killing_spawners(surface)
			planets[#planets + 1] = { surface = name, time = force.get_evolution_factor_by_time(surface),
				pollution = p - last.pollution, kills = k - last.kills }
			s.evolution[name] = { pollution = p, kills = k }
		end
	end
	send("gw.evolution.report", { planets = planets, timeFactor = ev.time_factor })
end

ue.runtime.scheduler.periodic({ name = "gw.evolution", interval = 3600, fn = evolution.report })

--- Spec §8's apply: the cluster's three parts, set on each planet surface this tile has, with the growth since its last
--- report kept on top, so a report and an apply that cross lose nothing.
ue.runtime.bridge.on("gridworld", "gw.evolution.apply", function(p)
	if type(p.planets) ~= "table" then
		return false
	end
	local s, force, applied = storage.gridworld, game.forces.enemy, {}
	if not (game.map_settings.enemy_evolution.enabled and border_core.on(s.toggles, "shared_evolution")) then
		return nil
	end
	for _, e in ipairs(p.planets) do
		local surface = s.tiles[e.surface] and game.get_surface(e.surface)
		if surface and type(e.time) == "number" and type(e.pollution) == "number" and type(e.kills) == "number" then
			local last = s.evolution[e.surface] or { pollution = 0, kills = 0 }
			local dp = force.get_evolution_factor_by_pollution(surface) - last.pollution
			local dk = force.get_evolution_factor_by_killing_spawners(surface) - last.kills
			local pollution, kills = e.pollution + dp, e.kills + dk
			force.set_evolution_factor_by_time(e.time, surface)
			force.set_evolution_factor_by_pollution(pollution, surface)
			force.set_evolution_factor_by_killing_spawners(kills, surface)
			-- Spike 34 E1: the engine keeps the total apart from its parts (setting them never moves it), and from a
			-- fresh map the total is S / (1 + S), S = time + pollution + kills; so set the total from the parts.
			local sum = e.time + pollution + kills
			force.set_evolution_factor(sum / (1 + sum), surface)
			s.evolution[e.surface] = { pollution = e.pollution, kills = e.kills }
			applied[#applied + 1] = e.surface
		end
	end
	tile.emit("gw.evolution", "applied", "verbose", nil, { surfaces = applied })
end)

return evolution
