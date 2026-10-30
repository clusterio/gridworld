local t = require("testlib")
local core = require("modules/gridworld/border_core")
local tile_core = require("modules/gridworld/tile_core")
local detect = require("modules/universal_edges/transports/detect_core")
local geometry = require("modules/universal_edges/edges/geometry_core")

local function tile(x, y, size)
	local x1, y1, x2, y2 = tile_core.bounds(x, y, size)
	return { x1 = x1, y1 = y1, x2 = x2, y2 = y2 }
end

t.test("frame: each side as gridworld's edge gives it (grid.ts edgeSpec); side_of finds it back", function()
	local b = tile(0, 0, 128)
	t.expect_same(core.frame(b, "n"), { origin = { -64, -64 }, facing = 0, length = 128 })
	t.expect_same(core.frame(b, "e"), { origin = { 64, -64 }, facing = 4, length = 128 })
	t.expect_same(core.frame(b, "s"), { origin = { 64, 64 }, facing = 8, length = 128 })
	t.expect_same(core.frame(b, "w"), { origin = { -64, 64 }, facing = 12, length = 128 })
	for _, side in ipairs({ "n", "e", "s", "w" }) do
		t.expect_eq(core.side_of(b, core.frame(b, side)), side)
	end
	t.expect_eq(core.side_of(b, { origin = { 64, -63 }, facing = 4, length = 128 }), nil, "another origin")
	t.expect_eq(core.side_of(b, { origin = { 64, -64 }, facing = 4, length = 64 }), nil, "another length")
end)

t.test("row1: the first outside row, corners without a side, each chunk's column on its side's frame, the oracle's "
	.. "column left out", function()
	local b = tile(0, 0, 128) -- chunks -2..1; the oracle's column is 2 (biters_core.oracle_x(128) = 80)
	local by, n = {}, 0
	for _, c in ipairs(core.row1(b)) do
		by[c.cx .. "," .. c.cy] = c
		n = n + 1
	end
	t.expect_eq(n, 16, "16 side chunks and 4 corners, less the 4 oracle chunks")
	t.expect_same(by["-2,-3"], { cx = -2, cy = -3, side = "n", col = 0 }, "north, west end: column 0")
	t.expect_eq(by["0,-3"], nil, "north column 2 is the oracle's")
	t.expect_same(by["2,-2"], { cx = 2, cy = -2, side = "e", col = 0 }, "east, north end: column 0")
	t.expect_eq(by["2,0"], nil, "east column 2")
	t.expect_same(by["1,2"], { cx = 1, cy = 2, side = "s", col = 0 }, "the south side runs west: its east end is column 0")
	t.expect_eq(by["-1,2"], nil, "south column 2 is chunk -1")
	t.expect_same(by["-3,1"], { cx = -3, cy = 1, side = "w", col = 0 }, "the west side runs north: its south end is column 0")
	t.expect_eq(by["-3,-1"], nil, "west column 2 is chunk row -1")
	t.expect_same(by["-3,-3"], { cx = -3, cy = -3 }, "a corner: no side, no column")
	t.expect_same(by["2,2"], { cx = 2, cy = 2 }, "the south-east corner")
end)

t.test("key and parse: a column, then the route it came by; parse undoes key", function()
	t.expect_eq(core.key(3, ""), "3")
	t.expect_eq(core.key(0, "gridworld:w:0,0:1,0:1,2"), "0|gridworld:w:0,0:1,0:1,2")
	t.expect_same({ core.parse("3") }, { 3, "" })
	t.expect_same({ core.parse("12|e1|e2") }, { 12, "e1|e2" })
	t.expect_eq(core.parse("x|e1"), nil, "not a column")
end)

t.test("has: an edge id is in a route only as a whole id", function()
	t.expect_true(core.has("e1|e2", "e2") and core.has("e1|e2", "e1"))
	t.expect_true(not core.has("e1|e22", "e2"), "a prefix isn't the id")
	t.expect_true(not core.has("", "e1"), "the empty route")
end)

t.test("bag: whole amounts, zeros out, onward keys whose route holds the edge dropped (R7); nil when empty", function()
	local own = { [0] = 10.4, [1] = 0.3, [3] = 2.5 }
	local onward = { ["2|e9"] = 7.6, ["1|e5|e9"] = 4, ["0|e5"] = 3 }
	t.expect_same(core.bag(own, onward, "e5"), { ["0"] = 10, ["3"] = 3, ["2|e9"] = 8 })
	t.expect_eq(core.bag({ [0] = 0.2 }, {}, "e5"), nil)
end)

t.test("fresh: a side's last report at most two windows old", function()
	t.expect_true(core.fresh(1000, 1000 + 2 * core.WINDOW))
	t.expect_true(not core.fresh(1000, 1001 + 2 * core.WINDOW))
	t.expect_true(not core.fresh(nil, 5))
end)

--- Whether (x, y) can be the centre of a real type entity of size facing d: a footprint side of odd length centres on a
--- half tile, an even one on a whole tile (a pump is 1×2 along its direction).
local function real(type, size, d, x, y)
	local function half(v)
		return v % 1 == 0.5
	end
	if type == "pump" then
		local ns = d % 8 == 0
		return half(ns and x or y) and (ns and y or x) % 1 == 0
	elseif size == 2 then
		return x % 1 == 0 and y % 1 == 0
	end
	return half(x) and half(y)
end

t.test("every build a side's border row proposes has its centre inside the tile, so §9.4 never destroys a proposed "
	.. "build (SP2 §19; playtest 2026-10-10)", function()
	local b = tile(1, -1, 64)
	local n, bad = 0, {}
	for _, side in ipairs({ "n", "e", "s", "w" }) do
		local f = core.frame(b, side)
		for type in pairs(detect.KIND) do
			local rail = type == "straight-rail" or type == "elevated-straight-rail"
			for _, size in ipairs(type == "electric-pole" and { 1, 2 } or { rail and 2 or 1 }) do
				for d = 0, 12, 4 do
					for lx = -2, f.length + 2, 0.5 do
						for ly = -3, 3, 0.5 do
							local wx, wy = geometry.to_world(f, lx, ly)
							local e = { type = type, x = wx, y = wy, direction = d, size = size, link = true }
							if real(type, size, d, wx, wy) and (detect.propose("a", f, e) or detect.propose("b", f, e)) then
								n = n + 1
								if not tile_core.inside(b, wx, wy) then
									bad[#bad + 1] = ("%s %s at %s,%s"):format(side, type, wx, wy)
								end
							end
						end
					end
				end
			end
		end
	end
	t.expect_true(n > 0, "something proposed")
	t.expect_eq(#bad, 0, "proposed with the centre outside: " .. table.concat(bad, "; ", 1, math.min(#bad, 5)))
end)
