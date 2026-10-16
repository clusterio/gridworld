-- The virtual cloud's rules (cross-border biters spec §5), pure: a tile's chunk grid, one 64-tick update by vanilla's law,
-- a spawner's take, and the units a pool buys at an evolution. No Factorio global, so lua5.2 runs it. A grid is
-- { [index] = amount } over the tile's n x n chunks, row by row from the north-west (index), holes meaning 0.
local core = {}

--- Chunk (cx, cy)'s index in tile t's grid, or nil outside it.
function core.index(t, cx, cy)
	local n = (t.x2 - t.x1) / 32
	local x, y = cx - t.x1 / 32, cy - t.y1 / 32
	if x < 0 or y < 0 or x >= n or y >= n then
		return nil
	end
	return y * n + x + 1
end

--- One update of grid v (spec §5): absorb[i] comes off first (spike 27: absorption runs before the same update spreads),
--- then a chunk holding more than min gives ratio of it to each of its four neighbours. Returns the new grid (empty
--- chunks left out) and what crossed each side, out[side][k] for the side's k-th border chunk, counted west to east
--- (n, s) or north to south (e, w).
function core.step(v, n, absorb, ratio, min)
	local nv, out = {}, { n = {}, e = {}, s = {}, w = {} }
	local function give(r, c, d, side, k)
		if r < 0 or r >= n or c < 0 or c >= n then
			out[side][k] = (out[side][k] or 0) + d
		else
			local j = r * n + c + 1
			nv[j] = (nv[j] or 0) + d
		end
	end
	for i, x in pairs(v) do
		local left = x - (absorb[i] or 0)
		if left > 0 then
			nv[i] = (nv[i] or 0) + left
			if left > min then
				local d = left * ratio
				local r, c = math.floor((i - 1) / n), (i - 1) % n
				nv[i] = nv[i] - 4 * d
				give(r - 1, c, d, "n", c + 1)
				give(r + 1, c, d, "s", c + 1)
				give(r, c - 1, d, "w", r + 1)
				give(r, c + 1, d, "e", r + 1)
			end
		end
	end
	return nv, out
end

--- The local column, on its side's own frame (border_core.frame), of the side's k-th border chunk as step counts it.
function core.col(side, n, k)
	if side == "n" or side == "e" then
		return k - 1
	end
	return n - k
end

function core.total(v)
	local sum = 0
	for _, x in pairs(v) do
		sum = sum + x
	end
	return sum
end

--- What a spawner takes in one 60-tick step from a chunk holding v (spike 25 B1), by its prototype's
--- absorptions_per_second for the pollutant (plan ruling R19).
function core.take(v, absolute, proportional)
	return math.min(v, absolute + proportional * v)
end

--- Each result unit's weight at evolution evo (spec §5: as vanilla weights them): the spawn points interpolated, flat past
--- the first and last. units is prototype.result_units ({ unit, spawn_points = { { evolution_factor, weight } } });
--- returns { { name, weight } } with weight > 0, in order.
function core.weights(units, evo)
	local out = {}
	for _, u in ipairs(units) do
		local pts = u.spawn_points
		local w = pts[#pts].weight
		if evo <= pts[1].evolution_factor then
			w = pts[1].weight
		else
			for k = 1, #pts - 1 do
				local p, q = pts[k], pts[k + 1]
				if evo < q.evolution_factor then
					w = p.weight + (evo - p.evolution_factor) / (q.evolution_factor - p.evolution_factor) * (q.weight - p.weight)
					break
				end
			end
		end
		if w > 0 then
			out[#out + 1] = { name = u.unit, weight = w }
		end
	end
	return out
end

--- The unit weights picks for r in [0, 1).
function core.pick(weights, r)
	local total = 0
	for _, w in ipairs(weights) do
		total = total + w.weight
	end
	local x = r * total
	for _, w in ipairs(weights) do
		x = x - w.weight
		if x < 0 then
			return w.name
		end
	end
	return weights[#weights].name
end

--- The pool's cap (spike 25 B1): 3 x the priciest unit with weight at this evolution; costs[name] is its
--- absorptions_to_join_attack for the pollutant.
function core.cap(weights, costs)
	local top = 0
	for _, w in ipairs(weights) do
		top = math.max(top, costs[w.name] or 0)
	end
	return 3 * top
end

--- The cheapest unit with weight that costs anything (math.huge for none): a pool that pays for it starts a raid.
function core.cheapest(weights, costs)
	local low = math.huge
	for _, w in ipairs(weights) do
		local c = costs[w.name]
		if c and c > 0 then
			low = math.min(low, c)
		end
	end
	return low
end

--- Units bought from pool (spec §5): one pick per rand() while the pool pays for the pick; a unit that costs nothing
--- ends it. At most max units are bought (nil = no limit, 0 = none). Returns the names bought and the pool left.
function core.buy(pool, weights, costs, rand, max)
	local bought = {}
	while #weights > 0 and (not max or #bought < max) do
		local name = core.pick(weights, rand())
		local cost = costs[name] or math.huge
		if cost <= 0 or cost > pool then
			break
		end
		pool = pool - cost
		bought[#bought + 1] = name
	end
	return bought, pool
end

return core
