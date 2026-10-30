local t = require("testlib")
local core = require("modules/gridworld/tile_core")

local function tile(x, y, size)
	local x1, y1, x2, y2 = core.bounds(x, y, size)
	return { x1 = x1, y1 = y1, x2 = x2, y2 = y2 }
end

t.test("bounds are [xT - T/2, xT + T/2) x [yT - T/2, yT + T/2), negative tiles included", function()
	t.expect_same({ core.bounds(0, 0, 512) }, { -256, -256, 256, 256 })
	t.expect_same({ core.bounds(-1, 2, 512) }, { -768, 768, -256, 1280 })
	t.expect_same({ core.bounds(3, -5, 64) }, { 160, -352, 224, -288 })
end)

t.test("a centre is inside on the west and north lines, outside on the east and south lines", function()
	local b = tile(0, 0, 64)
	t.expect_true(core.inside(b, 0, 0), "the middle")
	t.expect_true(core.inside(b, -32, -32), "the north-west corner point")
	t.expect_true(core.inside(b, -32, 10) and core.inside(b, 10, -32), "on the west line, on the north line")
	t.expect_true(not core.inside(b, 32, 10) and not core.inside(b, 10, 32), "on the east line, on the south line")
	t.expect_true(core.inside(b, 31.99, 31.99), "just inside the south-east corner")
	t.expect_true(not core.inside(b, -32.01, 0) and not core.inside(b, 0, -40), "past the west and north lines")
	local east = tile(1, 0, 64)
	t.expect_true(core.inside(east, 32, 10), "the east line of (0,0) belongs to (1,0)")
end)

t.test("chunks lie wholly inside or outside, for T = 64, 512, 1024 and 4096", function()
	for _, T in ipairs({ 64, 512, 1024, 4096 }) do
		for _, tx in ipairs({ 0, -1, 3 }) do
			local b = tile(tx, -2, T)
			local inside = 0
			for cx = math.floor(b.x1 / 32) - 2, math.floor(b.x2 / 32) + 1 do
				for cy = math.floor(b.y1 / 32) - 2, math.floor(b.y2 / 32) + 1 do
					if not core.chunk_outside(b, cx, cy) then
						inside = inside + 1
						t.expect_true(cx * 32 >= b.x1 and cx * 32 + 32 <= b.x2 and cy * 32 >= b.y1 and cy * 32 + 32 <= b.y2)
					end
				end
			end
			t.expect_eq(inside, (T / 32) ^ 2, "T = " .. T)
		end
	end
	local b = tile(0, 0, 512)
	t.expect_true(core.chunk_outside(b, 8, 0) and not core.chunk_outside(b, 7, 0), "east edge")
	t.expect_true(core.chunk_outside(b, -9, 0) and not core.chunk_outside(b, -8, 0), "west edge")
end)

t.test("corner_zone: past one line by 0.5 within 8 of the corner, or past both; held to 0 and 8.5 (crossing spec §3.2)", function()
	local b = { x1 = -32, y1 = -32, x2 = 32, y2 = 32 }
	t.expect_eq(core.corner_zone(b, 33, 31, nil), "se", "east strip, 1 tile from the corner")
	t.expect_eq(core.corner_zone(b, 33, 24.5, nil), "se", "east strip, 7.5 from the corner")
	t.expect_eq(core.corner_zone(b, 33, 23.5, nil), nil, "east strip, 8.5 from the corner: an edge, not a corner")
	t.expect_eq(core.corner_zone(b, 32.4, 31, nil), nil, "0.4 past: not crossed")
	t.expect_eq(core.corner_zone(b, 32.4, 31, "se"), "se", "held: 0.4 past is in the 0.5 band")
	t.expect_eq(core.corner_zone(b, 33, 23.7, "se"), "se", "held: 8.3 from the corner is within 8.5")
	t.expect_eq(core.corner_zone(b, 33, 23.3, "se"), nil, "8.7 from the corner: released")
	t.expect_eq(core.corner_zone(b, 31.9, 31, "se"), nil, "back inside: released")
	t.expect_eq(core.corner_zone(b, 36, 36, nil), "se", "the corner square")
	t.expect_eq(core.corner_zone(b, 58.5, 36, nil), nil, "26.5 out: past the barrier's far side")
	t.expect_eq(core.corner_zone(b, 31, 33, nil), "se", "south strip near the corner")
	t.expect_eq(core.corner_zone(b, 33, -31, nil), "ne", "north-east")
	t.expect_eq(core.corner_zone(b, -33, 31, nil), "sw", "south-west")
	t.expect_eq(core.corner_zone(b, -31, -33, nil), "nw", "north-west")
	t.expect_eq(core.corner_zone(b, 0, 0, nil), nil, "inside")
	t.expect_eq(core.corner_zone(b, 33, 31, "bogus"), "se", "an unknown current is ignored")
end)

t.test("inside_point: the nearest point 0.5 inside, its box within 8 and inside; nil from 26 out (crossing spec §6.2)", function()
	local b = { x1 = -32, y1 = -32, x2 = 32, y2 = 32 }
	local x, y, box = core.inside_point(b, 36, 34)
	t.expect_eq(x, 31.5, "x clamped")
	t.expect_eq(y, 31.5, "y clamped")
	t.expect_eq(box[1][1], 23.5, "box left: 8 back")
	t.expect_eq(box[1][2], 23.5, "box top")
	t.expect_eq(box[2][1], 31.5, "box right: 0.5 inside")
	t.expect_eq(box[2][2], 31.5, "box bottom")
	x, y = core.inside_point(b, 10, -5)
	t.expect_eq(x, 10, "inside stays")
	t.expect_eq(y, -5, "inside stays")
	t.expect_eq(core.inside_point(b, 58, 0), nil, "26 out on x: out of reach")
	t.expect_eq(core.inside_point(b, 0, -58), nil, "26 out on y: out of reach")
end)

t.test("contain: the inside_point answer without its FAR limit (crossing-arrival spec §5.2)", function()
	local b = { x1 = -32, y1 = -32, x2 = 32, y2 = 32 }
	local x, y, box = core.contain(b, 5, -141)
	t.expect_eq(x, 5, "x unchanged")
	t.expect_eq(y, -31.5, "y 0.5 inside the north line")
	t.expect_same(box, { { -3, -31.5 }, { 13, -23.5 } }, "box +-8 clipped to the shrunk tile")
	x, y, box = core.contain(b, 10, -5)
	t.expect_eq(x, 10, "inside stays")
	t.expect_eq(y, -5, "inside stays")
	t.expect_same(box, { { 2, -13 }, { 18, 3 } }, "inside: a full box")
	t.expect_true(core.inside_point(b, 0, -141) == nil, "inside_point still gives up FAR out")
end)

t.test("the generation square: the tile's centre chunk and a radius of T/64 + 4 chunks", function()
	t.expect_eq(core.MARGIN_CHUNKS, 4)
	t.expect_same({ core.gen_square(0, 0, 512) }, { 0, 0, 12 })
	t.expect_same({ core.gen_square(-1, 2, 64) }, { -2, 4, 5 })
	t.expect_same({ core.gen_square(40, 40, 64) }, { 80, 80, 5 })
end)

t.test("allow: once per key per window, and the next true counts the calls since the last", function()
	local limits = {}
	t.expect_same({ core.allow(limits, "k", 100, 3600) }, { true, 1 })
	t.expect_same({ core.allow(limits, "k", 200, 3600) }, { false })
	t.expect_same({ core.allow(limits, "k", 3699, 3600) }, { false })
	t.expect_same({ core.allow(limits, "other", 3699, 3600) }, { true, 1 })
	t.expect_same({ core.allow(limits, "k", 3700, 3600) }, { true, 3 })
end)

t.test("chunk_far: more than BAND = 3 chunks from the tile square, Chebyshev, corners included", function()
	local b = tile(0, 0, 64) -- chunks -1..0 on both axes
	t.expect_eq(core.BAND, 3)
	t.expect_true(not core.chunk_far(b, 1, 0), "row 1 east")
	t.expect_true(not core.chunk_far(b, 3, 0), "row 3 east")
	t.expect_true(core.chunk_far(b, 4, 0), "row 4 east")
	t.expect_true(not core.chunk_far(b, -4, -1), "row 3 west: -4 is 3 from -1")
	t.expect_true(core.chunk_far(b, -5, -1), "row 4 west")
	t.expect_true(not core.chunk_far(b, 3, 3) and not core.chunk_far(b, -4, 3), "diagonal corners at 3")
	t.expect_true(core.chunk_far(b, 4, 4) and core.chunk_far(b, 4, -5), "diagonal corners at 4")
	t.expect_true(core.chunk_far(b, 4, 0) and core.chunk_far(b, 0, 4), "either axis alone is enough")
end)

t.test("ring: how many chunks outside the tile square, Chebyshev, corners included", function()
	local b = tile(0, 0, 128) -- chunks -2..1 on each axis
	t.expect_eq(core.ring(b, 0, 0), 0, "inside")
	t.expect_eq(core.ring(b, 2, 0), 1, "the first row, east")
	t.expect_eq(core.ring(b, -3, -3), 1, "the first row's north-west corner")
	t.expect_eq(core.ring(b, -4, 1), 2, "the second row, west")
	t.expect_eq(core.ring(b, 3, 3), 2, "the second row's south-east corner")
	t.expect_eq(core.ring(b, 1, -6), 4, "four rows north")
	t.expect_true(core.chunk_far(b, 1, -6) and not core.chunk_far(b, 1, -5), "chunk_far is ring > BAND")
end)
