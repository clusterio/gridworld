-- "pure" Lua runs on plain Lua 5.2 (unit tests); everything under module/ and test/game/ runs inside Factorio.
std = "lua52"
max_line_length = 140
exclude_files = { "**/node_modules/**", "**/dist/**" }
stds.factorio = {
	-- storage is the one Factorio global our code writes: each plugin owns storage[<plugin name>].
	globals = { "storage" },
	read_globals = {
		"game", "script", "defines", "helpers", "prototypes", "settings", "remote",
		"commands", "rendering", "rcon", "log", "serpent", "table_size", "localised_print",
		"clusterio_private",
	},
}
files["**/module/**/*.lua"] = { std = "lua52+factorio" }
files["**/module/**/*_core.lua"] = { std = "lua52" }
files["**/test/game/**/*.lua"] = { std = "lua52+factorio", read_globals = { "ue_rt" } }
-- The biters run's cases (cross-border biters plan ruling R10), like the plugins run's.
files["**/test/biters/**/*.lua"] = { std = "lua52+factorio", read_globals = { "ue_rt" } }
-- Gridworld's RCON entry point is the one global its module defines; its game tests read it (SP2 spec §4).
files["module/globals.lua"] = { globals = { "gw_rt" } }
files["test/game/**/*.lua"] = { read_globals = { "gw_rt" } }
