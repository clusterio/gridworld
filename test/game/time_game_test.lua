local t = require("modules/v2_test/testlib")
local core = require("modules/gridworld/time_core")

-- The shared tile (tile_game_test.lua) is configured at tick 100, and again at 106-110, so gw.time applies from then. This
-- file owns ticks 200-299 and 2400-3850; nothing else writes Nauvis's daytime or ticks_per_day between 250 and 3850, or
-- Vulcanus's between 2400 and 3750. Surfaces are fetched with get_surface: luacheck flags a field written through a
-- read-only global's fields.
local seq = 0
local function deliver(msg_type, payload)
	seq = seq + 1
	ue_rt.inbox("gridworld", helpers.table_to_json({ { id = "00006e03." .. seq, type = msg_type, payload = payload } }))
end

local function traced(phase)
	local found = {}
	for _, msg in ipairs(storage.universal_edges.bridge.out.gridworld or {}) do
		if msg.type == "trace" and msg.payload.phase == phase then
			found[#found + 1] = msg.payload
		end
	end
	return found
end

t.case("time: daytime advances 1/ticks_per_day per tick, and writing ticks_per_day doesn't move it", function(ctx)
	ctx.at(200, function()
		local s = game.get_surface("nauvis")
		s.freeze_daytime = false
		s.ticks_per_day = 20000
		s.daytime = 0.25
	end)
	ctx.at(202, function()
		local s = game.get_surface("nauvis")
		ctx.expect(math.abs(s.daytime - (0.25 + 2 / 20000)) < 1e-9, "two ticks advanced 2/20000; daytime " .. s.daytime)
		local d = s.daytime
		s.ticks_per_day = 40000
		ctx.expect(s.daytime == d, "writing ticks_per_day left daytime where it was")
	end)
end)

t.case("time: a frozen surface is unfrozen, with one warning per boot", function(ctx)
	ctx.at(210, function()
		local s = game.get_surface("nauvis")
		s.freeze_daytime = true
		deliver("gw.time", { surface = "nauvis", daytime = s.daytime, base = 25000, period = 3600 })
		ctx.expect(not s.freeze_daytime, "unfrozen")
		s.freeze_daytime = true
		deliver("gw.time", { surface = "nauvis", daytime = s.daytime, base = 25000, period = 3600 })
		ctx.expect(not s.freeze_daytime, "unfrozen again")
		local warned = traced("unfrozen")
		ctx.expect(#warned == 1 and warned[1].level == "warn", "warned once")
	end)
end)

t.case("time: a drift outside [-A/2, A] snaps daytime to the canonical value", function(ctx)
	ctx.at(220, function()
		local s = game.get_surface("nauvis")
		storage.gridworld.time = {}
		s.daytime = 0.8
		deliver("gw.time", { surface = "nauvis", daytime = 0.5, base = 25000, period = 3600 })
		ctx.expect(s.daytime == 0.5, "snapped to c; daytime " .. s.daytime)
		ctx.expect(s.ticks_per_day == 25000, "at the measured rate")
		ctx.expect(#traced("snap") == 1, "and logged")
	end)
end)

t.case("time: one dead-beat period: 3600 ticks at the planned rate meet c + A", function(ctx)
	local c0
	ctx.at(250, function()
		storage.gridworld.time = {}
		c0 = (game.get_surface("nauvis").daytime + 0.01) % 1
		deliver("gw.time", { surface = "nauvis", daytime = c0, base = 25000, period = 3600 })
		ctx.expect(#traced("snap") == 0, "a drift of 0.01 doesn't snap")
	end)
	ctx.at(3850, function()
		local c1 = (c0 + 3600 / 25000) % 1
		local d = game.get_surface("nauvis").daytime
		ctx.expect(math.abs(core.wrap(c1 - d)) < 1e-4, "|d - c| = " .. math.abs(core.wrap(c1 - d)))
		deliver("gw.time", { surface = "nauvis", daytime = c1, base = 25000, period = 3600 })
		ctx.expect(#traced("snap") == 0, "the next sync doesn't snap either")
	end)
end)

t.case("time: a gw.time for a surface with no tile record is ignored, not an error (Review Focus 4)", function(ctx)
	ctx.at(270, function()
		local function errors()
			local b = storage.universal_edges.stats["ue.bridge"]
			return b and b.errors or 0
		end
		local other = game.create_surface("gw-time-other")
		other.ticks_per_day = 12345
		local before = errors()
		deliver("gw.time", { surface = "gw-time-other", daytime = 0.5, base = 25000, period = 3600 })
		deliver("gw.time", { surface = "pluto", daytime = 0.5, base = 25000, period = 3600 })
		ctx.expect(errors() == before, "no handler error")
		ctx.expect(other.ticks_per_day == 12345, "the surface's day is left alone")
		ctx.expect(storage.gridworld.time["gw-time-other"] == nil and storage.gridworld.time.pluto == nil, "no day state made")
		ctx.expect(#traced("snap") == 0, "nothing logged")
	end)
end)

--- The planets' days and periods (Task 1's recorded days; surfaces spec §9.1).
local GLEBA, FULGORA, VULCANUS = { base = 36000, period = 3600 }, { base = 10800, period = 2700 }, { base = 5400, period = 1350 }

t.case("time: Gleba (P = 3600) and Fulgora (P = 2700) each take their own base and period; a snap on one leaves the " ..
	"other alone (surfaces spec §9.5)", function(ctx)
	ctx.at(230, function()
		local gleba, fulgora = game.get_surface("gleba"), game.get_surface("fulgora")
		storage.gridworld.time.gleba, storage.gridworld.time.fulgora = nil, nil
		gleba.daytime, fulgora.daytime = 0.5, 0.5
		deliver("gw.time", { surface = "gleba", daytime = 0.5, base = GLEBA.base, period = GLEBA.period })
		deliver("gw.time", { surface = "fulgora", daytime = 0.5, base = FULGORA.base, period = FULGORA.period })
		ctx.expect(gleba.ticks_per_day == GLEBA.base and fulgora.ticks_per_day == FULGORA.base,
			"each at its own base: " .. gleba.ticks_per_day .. ", " .. fulgora.ticks_per_day)
		deliver("gw.time", { surface = "fulgora", daytime = 0.51, base = FULGORA.base, period = FULGORA.period })
		ctx.expect(fulgora.ticks_per_day == math.floor(FULGORA.period / (0.25 + 0.01) + 0.5),
			"Fulgora's period sets its rate: " .. fulgora.ticks_per_day)
		deliver("gw.time", { surface = "fulgora", daytime = 0.9, base = FULGORA.base, period = FULGORA.period })
		local snaps = traced("snap")
		ctx.expect(fulgora.daytime == 0.9 and #snaps == 1 and snaps[1].surface == "fulgora", "Fulgora snapped, and said so")
		ctx.expect(gleba.daytime == 0.5 and gleba.ticks_per_day == GLEBA.base, "Gleba untouched")
	end)
end)

t.case("time: on Vulcanus too, daytime advances 1/ticks_per_day per tick, and writing ticks_per_day doesn't move it " ..
	"(U7)", function(ctx)
	ctx.at(240, function()
		local s = game.get_surface("vulcanus")
		s.freeze_daytime = false
		s.ticks_per_day = VULCANUS.base
		s.daytime = 0.25
	end)
	ctx.at(242, function()
		local s = game.get_surface("vulcanus")
		ctx.expect(math.abs(s.daytime - (0.25 + 2 / VULCANUS.base)) < 1e-9, "two ticks advanced 2/5400; daytime " .. s.daytime)
		local d = s.daytime
		s.ticks_per_day = 2 * VULCANUS.base
		ctx.expect(s.daytime == d, "writing ticks_per_day left daytime where it was")
	end)
end)

t.case("time: Vulcanus's sync at P = 1350 is applied; one with P = 1351 is refused, since 4 × 1351 > 5400 (§9.5)", function(ctx)
	ctx.at(260, function()
		local s = game.get_surface("vulcanus")
		storage.gridworld.time.vulcanus = nil
		local d = s.daytime
		deliver("gw.time", { surface = "vulcanus", daytime = (d + 0.01) % 1, base = VULCANUS.base, period = VULCANUS.period })
		ctx.expect(s.ticks_per_day == math.floor(VULCANUS.period / (0.25 + 0.01) + 0.5), "applied: " .. s.ticks_per_day)
		local applied = s.ticks_per_day
		deliver("gw.time", { surface = "vulcanus", daytime = (d + 0.2) % 1, base = VULCANUS.base, period = 1351 })
		ctx.expect(s.ticks_per_day == applied, "refused: ticks_per_day unchanged")
	end)
end)

t.case("time: one dead-beat period on Vulcanus: 1350 ticks at the planned rate meet c + A", function(ctx)
	local c0
	ctx.at(2400, function()
		storage.gridworld.time.vulcanus = nil
		c0 = (game.get_surface("vulcanus").daytime + 0.01) % 1
		deliver("gw.time", { surface = "vulcanus", daytime = c0, base = VULCANUS.base, period = VULCANUS.period })
		ctx.expect(#traced("snap") == 0, "a drift of 0.01 doesn't snap")
	end)
	ctx.at(2400 + VULCANUS.period, function()
		local c1 = (c0 + VULCANUS.period / VULCANUS.base) % 1
		local d = game.get_surface("vulcanus").daytime
		ctx.expect(math.abs(core.wrap(c1 - d)) < 1e-4, "|d - c| = " .. math.abs(core.wrap(c1 - d)))
		deliver("gw.time", { surface = "vulcanus", daytime = c1, base = VULCANUS.base, period = VULCANUS.period })
		ctx.expect(#traced("snap") == 0, "the next sync doesn't snap either")
	end)
end)
