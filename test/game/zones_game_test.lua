local t = require("modules/v2_test/testlib")
local players = require("modules/universal_edges/transports/players")
local zones = require("modules/gridworld/zones")

-- Gridworld's corner zones through UE's crossing (crossing spec §3.2, §7.1): the shared tile is configured at tick 100.

t.case("zones: near a corner, past one line or both, the key is the corner's; an edge strip 9 tiles away is not",
	function(ctx)
	ctx.at(300, function()
		local b = storage.gridworld.tiles.nauvis
		local s = game.surfaces.nauvis
		ctx.expect(players.zone(s.index, "nauvis", b.x2 + 1, b.y2 - 3, nil) == "gridworld:se", "east strip near se")
		ctx.expect(players.zone(s.index, "nauvis", b.x2 + 2, b.y2 + 2, nil) == "gridworld:se", "the se square")
		ctx.expect(players.zone(s.index, "nauvis", b.x1 - 1, b.y1 + 3, nil) == "gridworld:nw", "west strip near nw")
		ctx.expect(players.zone(s.index, "nauvis", b.x2 + 1, b.y2 - 9, nil) ~= "gridworld:se", "9 tiles back: not the corner")
		ctx.expect(players.zone(s.index, "nauvis", b.x2 + 1, b.y2 - 8.3, "gridworld:se") == "gridworld:se", "held to 8.5")
	end)
end)

t.case("zones: a corner key's arrival lands inside this tile, at the nearest point to where they left", function(ctx)
	local who
	ctx.at(320, function()
		local b = storage.gridworld.tiles.nauvis
		local s = game.surfaces.nauvis
		who = s.create_entity({ name = "character", position = { (b.x1 + b.x2) / 2, (b.y1 + b.y2) / 2 }, force = "player" })
		ue_rt.player_join("zed", who.unit_number)
		ue_rt.inbox("universal_edges", helpers.table_to_json({ { id = "00006e07.1", type = "ue.player.arrival",
			payload = { player = "zed", entry = { key = "gridworld:nw", surface = "nauvis", x = b.x1 - 3, y = b.y1 - 2,
			trace = "t-zed" } } } }))
	end)
	ctx.at(322, function()
		local b = storage.gridworld.tiles.nauvis
		ctx.expect(who.position.x >= b.x1 + 0.5 and who.position.x <= b.x1 + 8.5 and who.position.y >= b.y1 + 0.5
			and who.position.y <= b.y1 + 8.5, "inside, near the north-west corner")
		who.destroy()
	end)
end)

t.case("zones: a body 109 tiles out with no entry is pulled in by the outside hook; one inside stays (crossing-arrival spec §5.2)",
	function(ctx)
	local far, home, corner, restore
	local asked = {}
	ctx.at(340, function()
		local b = storage.gridworld.tiles.nauvis
		local s = game.surfaces.nauvis
		local mx = (b.x1 + b.x2) / 2
		far = s.create_entity({ name = "character", position = { mx, b.y1 - 109 }, force = "player" })
		home = s.create_entity({ name = "character", position = { mx + 3, (b.y1 + b.y2) / 2 }, force = "player" })
		-- record what the outside hook is asked and answers, so the check is this case's own (not the rescue case's)
		local outside = players.outside
		players.outside = function(surface_name, x, y)
			local key, px, py, box = outside(surface_name, x, y)
			if key then
				asked[#asked + 1] = { y = y, key = key }
			end
			return key, px, py, box
		end
		restore = function()
			players.outside = outside
		end
		ue_rt.player_join("far", far.unit_number)
		ue_rt.player_join("home", home.unit_number)
		corner = s.create_entity({ name = "character", position = { b.x2 + 1, b.y2 - 3 }, force = "player" })
		ue_rt.player_join("cz", corner.unit_number)
		for i, name in ipairs({ "far", "home", "cz" }) do
			ue_rt.inbox("universal_edges", helpers.table_to_json({ { id = "00006e07." .. (10 + i), type = "ue.player.arrival",
				payload = { player = name } } }))
		end
		ctx.expect(zones.outside("no-such-surface", 0, 0) == nil, "no tile record: nil")
	end)
	ctx.at(342, function()
		local b = storage.gridworld.tiles.nauvis
		ctx.expect(far.position.y >= b.y1 + 0.5 and far.position.y <= b.y1 + 8.5, "far: inside, near the north line")
		ctx.expect(home.position.y == (b.y1 + b.y2) / 2, "home: not moved")
		restore()
		-- the hook answered for far alone; cz, in a zone, is left to §6.3 (and home, inside, gets nil)
		ctx.expect(#asked == 1 and asked[1].key == "gridworld:outside" and math.abs(asked[1].y - (b.y1 - 109)) < 2,
			"only far was answered by the outside hook")
		far.destroy()
		home.destroy()
		corner.destroy()
	end)
end)

t.case("zones: a body 50 tiles out of a vehicle is rescued inside; one in a zone or arriving stays (spec §5.3)",
	function(ctx)
	local far, corner, arr
	ctx.at(360, function()
		local b = storage.gridworld.tiles.nauvis
		local s = game.surfaces.nauvis
		local mx = (b.x1 + b.x2) / 2
		far = s.create_entity({ name = "character", position = { mx, b.y1 - 50 }, force = "player" })
		corner = s.create_entity({ name = "character", position = { b.x2 + 1, b.y2 - 3 }, force = "player" })
		arr = s.create_entity({ name = "character", position = { mx + 5, b.y1 - 50 }, force = "player" })
		local cy = corner.position.y
		ctx.expect(players.rescue("res-far", far) == true, "far: rescued")
		ctx.expect(far.position.y >= b.y1 + 0.5 and far.position.y <= b.y1 + 8.5, "far: inside, near the north line")
		ctx.expect(players.rescue("res-corner", corner) == false, "corner zone: false")
		ctx.expect(corner.position.y == cy, "corner zone: not moved")
		storage.universal_edges.players.arriving = storage.universal_edges.players.arriving or {}
		storage.universal_edges.players.arriving["res-arr"] = true
		ctx.expect(players.rescue("res-arr", arr) == false, "arriving: false")
		ctx.expect(arr.position.y == b.y1 - 50, "arriving: not moved")
		storage.universal_edges.players.arriving["res-arr"] = nil
		far.destroy()
		corner.destroy()
		arr.destroy()
	end)
end)
