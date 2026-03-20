--- Expose any globals here, typically just your control file if you want to access it through rcon or commands
-- luacheck: globals gridworld rail_sync_manager train_path_manager time_sync_manager
gridworld = require("modules/gridworld/control")
rail_sync_manager = require("modules/gridworld/rail_sync_manager")
train_path_manager = require("modules/gridworld/train_path_manager")
time_sync_manager = require("modules/gridworld/time_sync_manager")
