local t = require("testlib")
local core = require("modules/gridworld/time_core")

local B = 25000
local P = 3600
local A = P / B

--- A 5 % tick-rate step on every other period: 60 UPS, then 60 / 1.05.
local function alternating(k)
	return k % 2 == 1 and 60 / 1.05 or 60
end

--- The review simulation's generator (sp2-review/daysim.mjs), so these runs repeat its numbers exactly.
local function lcg(seed)
	local s = seed % 4294967296
	return function()
		s = (s * 1664525 + 1013904223) % 4294967296
		return s / 4294967296
	end
end

--- §11.3's recurrence, as the review simulated it, for a day of opt.B ticks synced every opt.P ticks (SP2's 25000 and
--- 3600 by default; surfaces spec §9.5): one sync per period, each sent at canonical time and delivered 0.05 s later,
--- with timer jitter, losses and a tick rate per period. Returns the snaps and the largest |drift| after period 2.
local function simulate(opt)
	local b, p = opt.B or B, opt.P or P
	local rng = lcg(opt.seed or 1)
	local rate = 60 / b -- canonical days per wall second
	local seconds = p / 60 -- the period in wall seconds
	local ups = opt.ups or function() return 60 end
	local wall, d, tpd, tick, next_send = 0, 0.3, b, 0, 0 -- wall, not t: t is the test library
	local last_tick, last_c
	local snaps, worst = 0, 0
	for k = 0, (opt.periods or 1440) - 1 do
		local w = 1 + (opt.jit and (rng() * 2 - 1) * opt.jit or 0)
		local sent = next_send
		next_send = sent + seconds * w
		local c = (sent * rate) % 1
		if not (opt.lost and opt.lost(k, rng)) then
			local at = math.max(sent + 0.05, wall)
			local ticks = ups(k) * (at - wall)
			d = (d + ticks / tpd) % 1
			tick = tick + ticks
			wall = at
			if k > 2 then
				worst = math.max(worst, math.abs(core.wrap((wall * rate) % 1 - d)))
			end
			local snap
			tpd, snap = core.plan(d, c, b, last_tick and tick - last_tick, last_c, p)
			if snap then
				d = c
				snaps = snaps + 1
			end
			last_tick, last_c = tick, c
		end
	end
	return snaps, worst
end

t.test("a sync at a steady rate closes the drift in one period (dead-beat)", function()
	local d, c = 0.10, 0.11
	local tpd, snap = core.plan(d, c, B, nil, nil, P)
	t.expect_eq(snap, false)
	t.expect_eq(tpd, math.floor(3600 / (A + 0.01) + 0.5))
	t.expect_true(math.abs(core.wrap((c + A) % 1 - (d + 3600 / tpd) % 1)) < 1e-5, "3600 ticks later it meets c + A")
	t.expect_same({ core.plan(0.5, 0.5, B, nil, nil, P) }, { B, false }, "no drift: the base rate")
end)

t.test("a drift outside [-A/2, A] snaps, at the measured rate; one inside doesn't", function()
	for _, delta in ipairs({ -A / 2 - 0.001, A + 0.001, 0.3, -0.3 }) do
		t.expect_same({ core.plan(0.5, (0.5 + delta) % 1, B, nil, nil, P) }, { B, true }, "delta " .. delta)
	end
	for _, delta in ipairs({ -A / 2 + 0.001, A - 0.001, 0 }) do
		local _, snap = core.plan(0.5, (0.5 + delta) % 1, B, nil, nil, P)
		t.expect_eq(snap, false, "delta " .. delta)
	end
end)

t.test("the drift wraps around 0 and 1", function()
	local tpd, snap = core.plan(0.99, 0.01, B, nil, nil, P)
	t.expect_eq(snap, false)
	t.expect_eq(tpd, math.floor(3600 / (A + 0.02) + 0.5), "0.99 to 0.01 is 0.02 ahead")
	tpd, snap = core.plan(0.01, 0.99, B, nil, nil, P)
	t.expect_eq(snap, false)
	t.expect_eq(tpd, math.floor(3600 / (A - 0.02) + 0.5), "and 0.01 to 0.99 is 0.02 behind")
	t.expect_eq(core.wrap(0.5), -0.5)
end)

t.test("N comes from the canonical advance since the last sync: a lost sync, out of range, no ticks, 30 UPS", function()
	local c = 0.5
	t.expect_eq(core.plan(0.5, c, B, nil, nil, P), B, "the first sync of a boot: N = 3600")
	t.expect_eq(core.plan(0.5, c, B, 7200, (c - 2 * A) % 1, P), B, "a lost sync: 7200 ticks for 2A, N = 3600")
	t.expect_eq(core.plan(0.5, c, B, 7200, (c - A / 8) % 1, P), B, "a canonical advance below A/4: N = 3600")
	t.expect_eq(core.plan(0.5, c, B, 100, (c - 0.8) % 1, P), B, "above 4A: N = 3600")
	t.expect_eq(core.plan(0.5, c, B, 0, (c - A) % 1, P), B, "no ticks since: N = 3600")
	t.expect_eq(core.plan(0.5, c, B, 1800, (c - A) % 1, P), B / 2, "30 UPS: 1800 ticks for A, N = 1800")
end)

t.test("a tile at a steady 25 UPS doesn't snap after the first sync", function()
	local snaps, worst = simulate({ ups = function() return 25 end, periods = 60 })
	t.expect_eq(snaps, 1, "only the first sync snaps")
	t.expect_true(worst < 1e-3, "worst |drift| " .. worst)
end)

t.test("24 hours of syncs: 5 % tick-rate steps with 5 % timer jitter, and 1 % of syncs lost", function()
	local snaps, worst = simulate({ jit = 0.05, ups = alternating })
	t.expect_eq(snaps, 1, "no snap after the first")
	t.expect_true(worst <= 0.01, "|drift| <= 0.01 throughout, got " .. worst)
	snaps = simulate({ lost = function(_, rng) return rng() < 0.01 end })
	t.expect_eq(snaps, 1, "1 % lost at a steady rate: no snap after the first")
end)

-- Surfaces spec §9.5: Vulcanus, B = 5400 and P = 1350, so A = 0.25, the largest any planet has (§9.1).
local VB, VP = 5400, 1350

t.test("Vulcanus (A = 0.25): a sync at a steady rate closes the drift in one period of 1350 ticks", function()
	local d, c = 0.10, 0.11
	local tpd, snap = core.plan(d, c, VB, nil, nil, VP)
	t.expect_eq(snap, false)
	t.expect_eq(tpd, math.floor(VP / (0.25 + 0.01) + 0.5))
	t.expect_true(math.abs(core.wrap((c + 0.25) % 1 - (d + VP / tpd) % 1)) < 1e-4, "P ticks later it meets c + A")
end)

t.test("at A = 0.25, a boot's first sync uses N = P, one lost sync (Δc = 0.5) is still measured, and 30 UPS halves N", function()
	local c = 0.5
	t.expect_eq(core.plan(0.5, c, VB, nil, nil, VP), VB, "the first sync of a boot: N = P")
	t.expect_eq(core.plan(0.5, c, VB, 2 * VP, (c - 0.5) % 1, VP), VB, "a lost sync: 2P ticks for 2A = 0.5, N = P")
	t.expect_eq(core.plan(0.5, c, VB, VP / 2, (c - 0.25) % 1, VP), VB / 2, "30 UPS: P/2 ticks for A, N = P/2")
end)

t.test("a short-day planet stays in sync: 24 hours on Vulcanus (3,840 periods) with 5 % rate steps, ±5 % jitter and " ..
	"1 % of syncs lost", function()
	local snaps, worst = simulate({ B = VB, P = VP, periods = 3840, jit = 0.05, ups = alternating,
		lost = function(_, rng) return rng() < 0.01 end })
	t.expect_eq(snaps, 1, "no snap after the first")
	-- §15.2 estimates 0.015 of a day (SP2's 0.0085 scaled by A). Report the value seen; over 0.02, stop and report it.
	t.expect_true(worst <= 0.02, "|drift| <= 0.02 of a day throughout, got " .. worst)
end)
