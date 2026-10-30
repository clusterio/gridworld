-- The day sync's control law (SP2 spec §11.2; surfaces spec §9.5: each planet's own period P), pure, so lua5.2 runs it and
-- its 24-hour simulations.
local core = {}

--- x wrapped into [-0.5, 0.5).
function core.wrap(x)
	return (x + 0.5) % 1 - 0.5
end

--- d: the surface's daytime; c: the canonical daytime; B: the base ticks per day; n: ticks since the last sync and
--- last_c its c, both nil at a boot's first sync; P: the sync period in ticks (surfaces spec §9.5; SP2's was 3600).
--- Returns ticks_per_day, and true when daytime must snap to c.
function core.plan(d, c, B, n, last_c, P)
	local A = P / B -- the canonical advance per period, in days
	local delta = core.wrap(c - d)
	local N = P -- ticks per period of canonical time, measured when the last sync allows
	if n and last_c and n > 0 then
		local dc = (c - last_c) % 1
		if dc >= A / 4 and dc <= 4 * A then
			N = n * A / dc
		end
	end
	local tpd0 = B * N / P -- holds the drift where it is
	local tpd = N / (A + delta) -- advances A + delta over the next N ticks
	if A + delta > 0 and tpd >= tpd0 / 2 and tpd <= 2 * tpd0 then
		return math.floor(tpd + 0.5), false
	end
	return math.floor(tpd0 + 0.5), true
end

return core
