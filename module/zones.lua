-- Gridworld's corner zones for UE's player crossing (player-crossing spec §3.2, §7.1): near a corner, past one line
-- or both, a player is offered the diagonal tile; a corner key's arrival lands at the nearest point inside this tile.
-- Tiles share world coordinates, so a recorded point needs no mapping, only clamping.
local ue = require("modules/universal_edges")
local core = require("modules/gridworld/tile_core")

local zones = {}

local function tile(surface)
	local s = storage.gridworld
	return s and s.tiles and s.tiles[surface]
end

function zones.zone(surface, x, y, current)
	local t = tile(surface)
	local corner = t and core.corner_zone(t, x, y, current and string.match(current, "^gridworld:(%a%a)$"))
	return corner and ("gridworld:" .. corner) or nil
end

function zones.place(surface, _, x, y)
	local t = tile(surface)
	if t then
		return core.inside_point(t, x, y)
	end
end

--- Crossing-arrival spec §5.2: a body outside this tile, at any distance, is brought back in.
function zones.outside(surface, x, y)
	local t = tile(surface)
	if t and not core.inside(t, x, y) then
		return core.contain(t, x, y)
	end
end

ue.players.zones({ name = "gridworld", zone = zones.zone, place = zones.place, outside = zones.outside })

return zones
