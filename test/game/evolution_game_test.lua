local t = require("modules/v2_test/testlib")
local evolution = require("modules/gridworld/evolution")
-- enemy_evolution.enabled is set in place, which luacheck reads as writing a read-only global's field (pre-flight B6).
-- luacheck: ignore 122

-- Shared evolution (cross-border biters spec §8; plan Task 10), on tile_game_test's configured tile, in ticks 600-699,
-- which gridworld's files leave free. An apply sets the cluster's parts on a planet this tile has, keeping the growth since
-- its last report on top (none here); with evolution off it changes nothing; the report goes out within the run (every
-- 3600 ticks). With the shared_evolution toggle off (owner, 2026-10-10), within one step, neither happens.
local seq = 0
local function deliver(payload)
	seq = seq + 1
	ue_rt.inbox("gridworld", helpers.table_to_json({ { id = "00006e09." .. seq, type = "gw.evolution.apply",
		payload = payload } }))
end

local function near(a, b)
	return math.abs(a - b) < 1e-9
end

t.case("evolution: an apply sets the three parts on a planet this tile has; off, it changes nothing; the report goes "
	.. "out (spec §8)", function(ctx)
	ctx.at(600, function()
		local f, surface = game.forces.enemy, game.surfaces.nauvis
		local before = { f.get_evolution_factor_by_time(surface), f.get_evolution_factor_by_pollution(surface),
			f.get_evolution_factor_by_killing_spawners(surface), f.get_evolution_factor(surface) }
		storage.gridworld.evolution.nauvis = { pollution = before[2], kills = before[3] } -- no growth since the report
		deliver({ planets = { { surface = "nauvis", time = 0.125, pollution = 0.25, kills = 0.0625 } } })
		ctx.expect(near(f.get_evolution_factor_by_time(surface), 0.125) and near(f.get_evolution_factor_by_pollution(surface),
			0.25) and near(f.get_evolution_factor_by_killing_spawners(surface), 0.0625), "the three parts")
		ctx.expect(near(f.get_evolution_factor(surface), 0.4375 / 1.4375), "the total is S / (1 + S) (spike 34 E1)")
		local total = f.get_evolution_factor(surface)
		game.map_settings.enemy_evolution.enabled = false
		deliver({ planets = { { surface = "nauvis", time = 0.5, pollution = 0.5, kills = 0 } } })
		ctx.expect(near(f.get_evolution_factor_by_time(surface), 0.125) and near(f.get_evolution_factor(surface), total),
			"off: unchanged")
		game.map_settings.enemy_evolution.enabled = true
		f.set_evolution_factor_by_time(before[1], surface)
		f.set_evolution_factor_by_pollution(before[2], surface)
		f.set_evolution_factor_by_killing_spawners(before[3], surface)
		f.set_evolution_factor(before[4], surface)
		storage.gridworld.evolution.nauvis = { pollution = before[2], kills = before[3] }
	end)
	ctx.expect_ipc("gridworld:out", '"gw.evolution.report"')
end)

--- The evolution reports queued this tick.
local function reports()
	local n = 0
	for _, msg in ipairs(storage.universal_edges.bridge.out.gridworld or {}) do
		n = n + (msg.type == "gw.evolution.report" and 1 or 0)
	end
	return n
end

t.case("evolution: with the shared_evolution toggle off, no report goes and an apply changes nothing; on, the report "
	.. "goes again", function(ctx)
	ctx.at(650, function()
		local s, f, surface = storage.gridworld, game.forces.enemy, game.surfaces.nauvis
		local time, total, n, was = f.get_evolution_factor_by_time(surface), f.get_evolution_factor(surface), reports(), s.toggles
		s.toggles = { shared_evolution = false }
		local ok, err = pcall(function()
			deliver({ planets = { { surface = "nauvis", time = 0.5, pollution = 0.5, kills = 0 } } })
			s.evolution.nauvis = { pollution = -1, kills = -1 }
			evolution.report()
		end)
		s.toggles = was
		ctx.expect(ok, "off: " .. tostring(err))
		ctx.expect(near(f.get_evolution_factor_by_time(surface), time) and near(f.get_evolution_factor(surface), total),
			"off: the apply changed nothing")
		ctx.expect(reports() == n and s.evolution.nauvis.pollution == -1, "off: no report")
		evolution.report()
		ctx.expect(reports() == n + 1 and s.evolution.nauvis.pollution >= 0, "on: the report goes")
	end)
end)
