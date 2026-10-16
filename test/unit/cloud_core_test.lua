local t = require("testlib")
local core = require("modules/gridworld/cloud_core")
local tile_core = require("modules/gridworld/tile_core")

local function near(a, b)
	return a ~= nil and math.abs(a - b) < 1e-9
end

t.test("index: a tile's chunks row by row from the north-west, nil outside", function()
	local x1, y1, x2, y2 = tile_core.bounds(0, 0, 128) -- chunks -2..1
	local b = { x1 = x1, y1 = y1, x2 = x2, y2 = y2 }
	t.expect_eq(core.index(b, -2, -2), 1)
	t.expect_eq(core.index(b, 1, -2), 4)
	t.expect_eq(core.index(b, -2, -1), 5)
	t.expect_eq(core.index(b, 1, 1), 16)
	t.expect_eq(core.index(b, 2, 0), nil)
end)

t.test("step: absorption first, then 2 % to each neighbour of a chunk above 15 (spec §5, spike 27)", function()
	local v, out = core.step({ [5] = 1000 }, 3, { [5] = 5 }, 0.02, 15) -- 3 x 3, the middle is 5
	t.expect_true(near(v[5], 995 - 4 * 19.9), "the middle keeps 995 less four shares")
	for _, i in ipairs({ 2, 4, 6, 8 }) do
		t.expect_true(near(v[i], 19.9), "neighbour " .. i)
	end
	t.expect_eq(v[1], nil, "a diagonal gets nothing")
	t.expect_same(out, { n = {}, e = {}, s = {}, w = {} }, "nothing leaves")
end)

t.test("step: at or under min nothing spreads; absorption takes a chunk to nothing, and it is left out", function()
	local v = core.step({ [5] = 15, [1] = 3 }, 3, { [1] = 5 }, 0.02, 15)
	t.expect_same(v, { [5] = 15 })
end)

t.test("step: a border chunk's share across the line is its side's flow, by its place along the side", function()
	local v, out = core.step({ [1] = 100, [6] = 50 }, 3, {}, 0.02, 15) -- 1: north-west corner; 6: the east side's middle
	t.expect_true(near(out.n[1], 2) and near(out.w[1], 2), "the corner gives north and west")
	t.expect_true(near(out.e[2], 1), "the east middle gives east, second along")
	t.expect_eq(next(out.s), nil, "nothing south")
	t.expect_true(near(v[1], 92) and near(v[6], 46), "each keeps the rest")
	t.expect_true(near(v[2], 2) and near(v[4], 2) and near(v[3], 1) and near(v[9], 1) and near(v[5], 1), "inside shares")
end)

t.test("col: the k-th border chunk's column on its side's own frame (n, e count up; s, w count down)", function()
	t.expect_eq(core.col("n", 4, 1), 0)
	t.expect_eq(core.col("e", 4, 4), 3)
	t.expect_eq(core.col("s", 4, 1), 3)
	t.expect_eq(core.col("w", 4, 4), 0)
end)

t.test("take: min(v, absolute + proportional x v) (spike 25 B1)", function()
	t.expect_eq(core.take(1000, 20, 0.01), 30)
	t.expect_eq(core.take(10, 20, 0.01), 10)
end)

local SPAWNER = { -- biter-spawner's small and medium biters, as prototype.result_units reads them
	{ unit = "small-biter", spawn_points = { { evolution_factor = 0, weight = 0.3 }, { evolution_factor = 0.6, weight = 0 } } },
	{ unit = "medium-biter", spawn_points = { { evolution_factor = 0.2, weight = 0 }, { evolution_factor = 0.6, weight = 0.3 },
		{ evolution_factor = 0.7, weight = 0.1 } } },
}

t.test("weights: spawn points interpolated, flat past the ends, zero weights left out (spec §5)", function()
	t.expect_same(core.weights(SPAWNER, 0), { { name = "small-biter", weight = 0.3 } })
	local w = core.weights(SPAWNER, 0.4)
	t.expect_true(#w == 2 and near(w[1].weight, 0.1) and near(w[2].weight, 0.15), "both at 0.4")
	t.expect_same(core.weights(SPAWNER, 1), { { name = "medium-biter", weight = 0.1 } })
end)

t.test("pick, cap, cheapest and buy", function()
	local w = { { name = "a", weight = 1 }, { name = "b", weight = 3 } }
	t.expect_eq(core.pick(w, 0), "a")
	t.expect_eq(core.pick(w, 0.24), "a")
	t.expect_eq(core.pick(w, 0.25), "b")
	t.expect_eq(core.pick(w, 0.99), "b")
	local costs = { a = 4, b = 20 }
	t.expect_eq(core.cap(w, costs), 60, "3 x the priciest")
	t.expect_eq(core.cheapest(w, costs), 4)
	t.expect_eq(core.cheapest({ { name = "z", weight = 1 } }, { z = 0 }), math.huge, "a unit that costs nothing isn't one")
	local names, pool = core.buy(30, { { name = "a", weight = 1 } }, costs, function() return 0 end)
	t.expect_eq(#names, 7)
	t.expect_eq(pool, 2)
	local none, left = core.buy(30, { { name = "z", weight = 1 } }, { z = 0 }, function() return 0 end)
	t.expect_true(#none == 0 and left == 30, "a unit that costs nothing is never bought (no endless loop)")
	local three, rest = core.buy(30, { { name = "a", weight = 1 } }, costs, function() return 0 end, 3)
	t.expect_true(#three == 3 and rest == 18, "max = 3 buys exactly 3 and leaves the rest of the pool")
	local zero, whole = core.buy(30, { { name = "a", weight = 1 } }, costs, function() return 0 end, 0)
	t.expect_true(#zero == 0 and whole == 30, "max = 0 buys none")
end)
