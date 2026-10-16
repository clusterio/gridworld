-- Pure tile geometry (SP2 spec §9.1, §12.1) and Lua's rate limiter (§16). It touches no Factorio global, so lua5.2
-- runs it. A tile t is any table with x1, y1, x2, y2: the bounds [x1, x2) x [y1, y2) in world coordinates.
local geometry = require("modules/universal_edges/edges/geometry_core")
local core = {}

--- Chunks the generation square adds beyond the tile on each side (§9.1): v1's margin; it covers UE's barriers,
--- at most 26 map tiles out, and a v1-sized train box.
core.MARGIN_CHUNKS = 4

--- Tile (x, y) of size T covers [xT - T/2, xT + T/2) x [yT - T/2, yT + T/2) (§5.1).
function core.bounds(x, y, size)
	local h = size / 2
	return x * size - h, y * size - h, x * size + h, y * size + h
end

--- Whether a position, an entity's centre, lies within t (§9.1): v1's rule on the half-open bounds, so a centre on a
--- border line belongs to exactly one tile.
function core.inside(t, x, y)
	return x >= t.x1 and x < t.x2 and y >= t.y1 and y < t.y2
end

--- Whether chunk (cx, cy) lies outside t; exact, because T/2 is a multiple of 32.
function core.chunk_outside(t, cx, cy)
	local x, y = cx * 32, cy * 32
	return x < t.x1 or y < t.y1 or x + 32 > t.x2 or y + 32 > t.y2
end

--- Chunks of decoratives kept around the tile (owner ruling 2026-10-10), so the world looks normal until it ends.
core.BAND = 3

--- How many chunks chunk (cx, cy) lies outside the tile square (Chebyshev, in chunks): 0 inside, 1 for the first outside
--- row, its corners included, 2 for the second. Tiles are chunk-aligned, so the tile's chunks are x1/32 .. x2/32 - 1 and
--- y1/32 .. y2/32 - 1.
function core.ring(t, cx, cy)
	local dx = math.max(t.x1 / 32 - cx, cx - (t.x2 / 32 - 1), 0)
	local dy = math.max(t.y1 / 32 - cy, cy - (t.y2 / 32 - 1), 0)
	return math.max(dx, dy)
end

--- Whether outside chunk (cx, cy) is more than BAND chunks from the tile square, so all its decoratives are destroyed.
function core.chunk_far(t, cx, cy)
	return core.ring(t, cx, cy) > core.BAND
end

--- The barrier's far side (SP1 §9): nothing this far out is in a zone or within reach.
core.FAR = geometry.DEPTH + geometry.SIZE / 2
--- How far back along each edge a corner zone reaches (crossing spec §3.2, owner 2026-10-13).
core.CORNER_REACH = 8

local CORNERS = { "ne", "se", "sw", "nw" }
local IS_CORNER = { ne = true, se = true, sw = true, nw = true }

--- The two depths past a corner's lines (positive outside), from the four sides' depths.
local function depths(c, e, w, s, n)
	if c == "ne" then
		return e, n
	elseif c == "se" then
		return e, s
	elseif c == "sw" then
		return w, s
	end
	return w, n
end

local function near(a, b, past, reach)
	return (a > past and b > -reach) or (b > past and a > -reach)
end

--- The corner zone (x, y) is in (crossing spec §3.2): past one of the corner's lines by more than 0.5 and within
--- CORNER_REACH of the corner along the other, which includes the corner square; nil otherwise, or from FAR out.
--- current, the player's corner now, holds while past by more than 0 and within CORNER_REACH + 0.5 (the 0.5 band).
--- No allocation: this runs on every move of every player.
function core.corner_zone(t, x, y, current)
	local e, w, s, n = x - t.x2, t.x1 - x, y - t.y2, t.y1 - y
	if e >= core.FAR or w >= core.FAR or s >= core.FAR or n >= core.FAR then
		return nil
	end
	if IS_CORNER[current] then
		local a, b = depths(current, e, w, s, n)
		if near(a, b, 0, core.CORNER_REACH + 0.5) then
			return current
		end
	end
	for i = 1, 4 do
		local a, b = depths(CORNERS[i], e, w, s, n)
		if near(a, b, 0.5, core.CORNER_REACH) then
			return CORNERS[i]
		end
	end
	return nil
end

--- (x, y) clamped into t shrunk by 0.5, with a box of +-8 clipped to it (crossing-arrival spec §5.2): inside_point
--- without its FAR limit.
function core.contain(t, x, y)
	local lx, ly, hx, hy = t.x1 + 0.5, t.y1 + 0.5, t.x2 - 0.5, t.y2 - 0.5
	local px, py = math.min(math.max(x, lx), hx), math.min(math.max(y, ly), hy)
	return px, py, { { math.max(px - 8, lx), math.max(py - 8, ly) }, { math.min(px + 8, hx), math.min(py + 8, hy) } }
end

--- The nearest point at least 0.5 inside t to (x, y), and the box within 8 of it and 0.5 inside t, where a free spot
--- is looked for (crossing spec §6.2); nil when (x, y) is FAR or more outside t on either axis.
function core.inside_point(t, x, y)
	if x <= t.x1 - core.FAR or x >= t.x2 + core.FAR or y <= t.y1 - core.FAR or y >= t.y2 + core.FAR then
		return nil
	end
	return core.contain(t, x, y)
end

--- The generation square (§9.1): the chunk holding tile (x, y)'s centre, and a radius of T/64 + MARGIN_CHUNKS.
function core.gen_square(x, y, size)
	return x * size / 32, y * size / 32, size / 64 + core.MARGIN_CHUNKS
end

--- True at most once per key per window ticks; the second value counts the calls since the last true, this one
--- included. limits lives in storage, so every peer agrees (Planning ruling 2).
--- ponytail: keys are never evicted; they are per player and per event kind, so the table stays small.
function core.allow(limits, key, tick, window)
	local e = limits[key]
	if e and tick - e.tick < window then
		e.count = e.count + 1
		return false
	end
	limits[key] = { tick = tick, count = 0 }
	return true, (e and e.count or 0) + 1
end

return core
