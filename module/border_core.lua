-- The border's pure rules (cross-border biters spec §4): what is sunk and on which pollutants, the first outside row with
-- each chunk's column, the sides' frames, and the leak report's bag. No Factorio global, so lua5.2 runs it. A tile t is
-- any table with x1, y1, x2, y2 (multiples of 32).
local geometry = require("modules/universal_edges/edges/geometry_core")
local biters = require("modules/universal_edges/transports/biters_core")
local core = {}

--- The sink (spec §4): UE's data mod carries it (plan ruling R1), so ue.owns keeps it through the outside cleanup.
core.SINK = "ue-pollution-sink"

--- The pollutants whose border is swept, reported and sunk (plan ruling R11): Gleba's spores joined after spike 34 G1.
core.POLLUTANTS = { pollution = true, spores = true }

--- The leak report's window in ticks (spec §4: about 600): the pollution connector's poll interval (plan ruling R20).
core.WINDOW = 600

--- Side t's frame as gridworld's own edge gives it (grid.ts edgeSpec): outward normal facing, local x along the side.
function core.frame(t, side)
	local L = t.x2 - t.x1
	if side == "n" then
		return { origin = { t.x1, t.y1 }, facing = 0, length = L }
	elseif side == "e" then
		return { origin = { t.x2, t.y1 }, facing = 4, length = L }
	elseif side == "s" then
		return { origin = { t.x2, t.y2 }, facing = 8, length = L }
	end
	return { origin = { t.x1, t.y2 }, facing = 12, length = L }
end

core.SIDE = { [0] = "n", [4] = "e", [8] = "s", [12] = "w" }

--- Which side of t frame f is, or nil: the side's own frame, by facing, origin and length.
function core.side_of(t, f)
	local side = core.SIDE[f.facing]
	local own = side and core.frame(t, side)
	if own and own.length == f.length and own.origin[1] == f.origin[1] and own.origin[2] == f.origin[2] then
		return side
	end
	return nil
end

--- Spec §4's sweep: the first outside row, { cx, cy, side, col } per chunk, side and col nil at the four corners (swept
--- and dropped); col is the chunk's local column on its side's frame. The oracle's column is left out: its pollution
--- must reach the oracle (spec §6.3; plan ruling R13).
function core.row1(t)
	local cx1, cy1, cx2, cy2 = t.x1 / 32, t.y1 / 32, t.x2 / 32 - 1, t.y2 / 32 - 1
	local mid = math.floor(biters.oracle_x(t.x2 - t.x1) / 32)
	local out = {}
	local function add(cx, cy, side)
		local col
		if side then
			col = math.floor(geometry.to_local(core.frame(t, side), cx * 32 + 16, cy * 32 + 16) / 32)
		end
		if col ~= mid then
			out[#out + 1] = { cx = cx, cy = cy, side = side, col = col }
		end
	end
	for cx = cx1 - 1, cx2 + 1 do
		local along = cx >= cx1 and cx <= cx2
		add(cx, cy1 - 1, along and "n" or nil)
		add(cx, cy2 + 1, along and "s" or nil)
	end
	for cy = cy1, cy2 do
		add(cx1 - 1, cy, "w")
		add(cx2 + 1, cy, "e")
	end
	return out
end

--- A leak report's bag key (plan rulings R3, R5): the column, then the route the pollution came by ("" for the sender's
--- own leak), joined by "|". Edge ids never hold a "|" (grid.ts edgeId).
function core.key(col, route)
	if route == "" then
		return tostring(col)
	end
	return col .. "|" .. route
end

--- A bag key's column (a number) and route, or nil for a key that isn't one.
function core.parse(key)
	local col, route = string.match(key, "^(%d+)|?(.*)$")
	if not col then
		return nil
	end
	return tonumber(col), route
end

--- Whether edge is one of route's ids.
function core.has(route, edge)
	return string.find("|" .. route .. "|", "|" .. edge .. "|", 1, true) ~= nil
end

--- The bag a side sends (spec §4, §6.4): own = { [col] = amount } swept from this tile's first row, onward = { [key] =
--- amount } from the virtual cloud, less the keys whose route already holds edge (plan ruling R7: nothing goes back the
--- way it came). Amounts rounded to whole numbers (a stream bag holds whole numbers), zeros left out; nil when empty.
function core.bag(own, onward, edge)
	local bag, n = {}, 0
	for col, v in pairs(own) do
		local w = math.floor(v + 0.5)
		if w > 0 then
			bag[tostring(col)], n = w, n + 1
		end
	end
	for key, v in pairs(onward) do
		local _, route = core.parse(key)
		local w = math.floor(v + 0.5)
		if w > 0 and not core.has(route, edge) then
			bag[key], n = w, n + 1
		end
	end
	return n > 0 and bag or nil
end

--- Whether a side's last report (its tick, or nil) is at most two windows old: its edge is live (plan ruling R3).
function core.fresh(stamp, tick)
	return stamp ~= nil and tick - stamp <= 2 * core.WINDOW
end

--- Whether biter toggle name (owner, 2026-10-10) is on. toggles is storage.gridworld.toggles, as the last gw.tile.config
--- carrying them left it (tile.lua); never set, every toggle is on.
function core.on(toggles, name)
	return not toggles or toggles[name] ~= false
end

return core
