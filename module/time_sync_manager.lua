local time_sync_manager = {}

local SNAP_THRESHOLD = 0.05
local CONVERGE_THRESHOLD = 0.005
local CORRECTION_FACTOR = 2.0

--- Called via RCON when the controller sends a canonical daytime value.
---@param json_str string JSON: { daytime: number, is_startup: boolean, ticks_per_day: number }
function time_sync_manager.apply_canonical_daytime(json_str)
	local data = helpers.json_to_table(json_str)
	if not data then return end

	local config = storage.gridworld
	if not config or config.is_pathworld then return end

	local surface_name = config.surface_name or "nauvis"
	local surface = game.surfaces[surface_name]
	if not surface then return end

	local canonical = data.daytime
	local is_startup = data.is_startup
	local base_tpd = data.ticks_per_day or 25000
	local min_tpd = math.floor(base_tpd * 0.5)
	local max_tpd = math.floor(base_tpd * 2.0)

	if is_startup then
		log(string.format("[time_sync] startup snap: canonical=%.4f current=%.4f ticks_per_day=%d", canonical, surface.daytime, base_tpd))
		surface.daytime = canonical
		surface.ticks_per_day = base_tpd
		config.time_sync = { correcting = false, base_tpd = base_tpd }
		return
	end

	local drift = canonical - surface.daytime
	-- Wrap to [-0.5, 0.5]
	if drift > 0.5 then drift = drift - 1.0 end
	if drift < -0.5 then drift = drift + 1.0 end

	if math.abs(drift) > SNAP_THRESHOLD then
		log(string.format("[time_sync] drift snap: drift=%.4f canonical=%.4f current=%.4f", drift, canonical, surface.daytime))
		surface.daytime = canonical
		surface.ticks_per_day = base_tpd
		config.time_sync = { correcting = false, base_tpd = base_tpd }
		return
	end

	if math.abs(drift) < CONVERGE_THRESHOLD then
		log(string.format("[time_sync] in sync: drift=%.4f", drift))
		surface.ticks_per_day = base_tpd
		config.time_sync = { correcting = false, base_tpd = base_tpd }
		return
	end

	-- Gradual correction by adjusting ticks_per_day
	-- drift > 0 means we're behind -> speed up (lower ticks_per_day)
	-- drift < 0 means we're ahead -> slow down (higher ticks_per_day)
	local adjustment = 1.0 - (drift * CORRECTION_FACTOR)
	local new_tpd = math.floor(base_tpd * adjustment)
	new_tpd = math.max(min_tpd, math.min(max_tpd, new_tpd))
	log(string.format("[time_sync] correcting: drift=%.4f ticks_per_day=%d->%d", drift, surface.ticks_per_day, new_tpd))
	surface.ticks_per_day = new_tpd
	config.time_sync = { correcting = true, canonical = canonical, base_tpd = base_tpd }
end

--- Periodic convergence check. Restores normal ticks_per_day once drift is small.
function time_sync_manager.check_convergence()
	local config = storage.gridworld
	if not config or config.is_pathworld then return end
	local ts = config.time_sync
	if not ts or not ts.correcting then return end

	local base_tpd = ts.base_tpd or 25000

	local surface_name = config.surface_name or "nauvis"
	local surface = game.surfaces[surface_name]
	if not surface then return end

	local drift = (ts.canonical or 0) - surface.daytime
	if drift > 0.5 then drift = drift - 1.0 end
	if drift < -0.5 then drift = drift + 1.0 end

	if math.abs(drift) < CONVERGE_THRESHOLD then
		log(string.format("[time_sync] converged: drift=%.4f, restoring ticks_per_day=%d", drift, base_tpd))
		surface.ticks_per_day = base_tpd
		ts.correcting = false
	end
end

return time_sync_manager
