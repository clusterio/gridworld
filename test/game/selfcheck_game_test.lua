local t = require("modules/v2_test/testlib")

t.case("gw.selfcheck runs on UE's scheduler and its event reaches gridworld's bridge channel", function(ctx)
	ctx.at(1, function()
		ctx.expect(storage.gridworld ~= nil and storage.gridworld.schema == 5, "gridworld's storage table at schema 5")
	end)
	ctx.expect_ipc("gridworld:out", '"op":"gw.selfcheck"')
	ctx.expect_ipc("gridworld:out", '"level":"verbose"')
end)
