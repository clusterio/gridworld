-- Gridworld's RCON entry point (SP2 spec §4): its state.
gw_rt = {
	--- /sc rcon.print(helpers.table_to_json(gw_rt.state())): one record per planet surface (surfaces spec §8.1).
	state = function()
		local s = storage.gridworld
		local cleanup = 0
		for _ in pairs(s.cleanup) do
			cleanup = cleanup + 1
		end
		return {
			schema = s.schema, tiles = s.tiles, configured = s.configured, cleanup = cleanup, time = s.time, stats = s.stats,
		}
	end,
}
