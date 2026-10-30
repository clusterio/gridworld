local t = require("testlib")
local core = require("modules/universal_edges/runtime/migrations_core")
local gw_schema = require("modules/gridworld/schema_core")

local upto3 = { gw_schema[1], gw_schema[2], gw_schema[3] }
local STATS = { syncs = 0, snaps = 0, max_drift = 0, chunks = 0, entities = 0 }
local SCHEMA_2 = {
	schema = 2, configured = false, swept = false, cleanup = {}, time = {}, limits = {}, stats = STATS,
}
local SCHEMA_3 = {
	schema = 3, configured = false, tiles = {}, cleanup = {}, time = {}, limits = {}, stats = STATS,
}

t.test("gridworld migration 1: before/after fixture", function()
	t.expect_same(core.run({ schema = 0 }, { gw_schema[1] }), { schema = 1 })
end)

t.test("gridworld migration 2: before/after fixture, keeping what the table held", function()
	local upto2 = { gw_schema[1], gw_schema[2] }
	local after = core.run({ schema = 1, kept = true }, upto2)
	t.expect_eq(after.kept, true)
	after.kept = nil
	t.expect_same(after, SCHEMA_2)
	t.expect_same(core.run({ schema = 0 }, upto2), SCHEMA_2, "a fresh table reaches schema 2")
end)

t.test("gridworld migration 3 (surfaces spec §8.1): the tile, its sweep, generation and cleanup move under tiles.nauvis",
	function()
	local tile = { world = "w", x = 1, y = 0, size = 64, surface = "nauvis", seed = 7, x1 = 32, y1 = -32, x2 = 96, y2 = 32 }
	local before = {
		schema = 2, configured = true, swept = true, gen = { pending = 3, chunks = 9, trace = "g" }, tile = tile,
		cleanup = { ["3,-1"] = { cx = 3, cy = -1 }, ["-2,0"] = { cx = -2, cy = 0 } },
		time = { last_tick = 5, last_c = 0.5, unfrozen = true },
		limits = { k = { tick = 1, count = 0 } }, stats = STATS,
	}
	t.expect_same(core.run(before, upto3), {
		schema = 3, configured = true,
		tiles = { nauvis = { world = "w", x = 1, y = 0, size = 64, surface = "nauvis", seed = 7, x1 = 32, y1 = -32, x2 = 96,
			y2 = 32, swept = true, gen = { pending = 3, chunks = 9, trace = "g" } } },
		cleanup = {
			["nauvis|3,-1"] = { surface = "nauvis", cx = 3, cy = -1 },
			["nauvis|-2,0"] = { surface = "nauvis", cx = -2, cy = 0 },
		},
		time = {},
		limits = { k = { tick = 1, count = 0 } }, stats = STATS,
	})
	t.expect_same(core.run({ schema = 0 }, upto3), SCHEMA_3, "a fresh table reaches schema 3: no tile, empty tiles")
end)

t.test("gridworld migration 4: every record is swept again, the rest kept", function()
	local before = { schema = 3, tiles = { nauvis = { swept = true, x1 = 1 }, gleba = { swept = true } }, cleanup = {} }
	t.expect_same(core.run(before, { table.unpack(gw_schema, 1, 4) }), {
		schema = 4, tiles = { nauvis = { swept = false, x1 = 1 }, gleba = { swept = false } }, cleanup = {},
	})
end)

t.test("gridworld migration 5 (cross-border biters): every record is swept again, and the border's tables exist", function()
	local before = { schema = 4, tiles = { nauvis = { swept = true, x1 = 1 } }, cleanup = {} }
	t.expect_same(core.run(before, gw_schema), {
		schema = 5, tiles = { nauvis = { swept = false, x1 = 1 } }, cleanup = {},
		sweep = {}, live = {}, cloud = {}, absorb_q = {}, evolution = {},
	})
end)

t.test("a fresh table reaches schema 5 in its final shape: no corners, the border's tables", function()
	t.expect_same(core.run({ schema = 0 }, gw_schema), {
		schema = 5, configured = false, tiles = {}, cleanup = {}, time = {}, limits = {}, stats = STATS,
		sweep = {}, live = {}, cloud = {}, absorb_q = {}, evolution = {},
	})
end)
