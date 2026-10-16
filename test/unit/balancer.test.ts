import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadBalancerApi } from "../../world/balancer.js";

test("loadBalancerApi: balancerApi from the balancer's plugin list entry; else undefined", async () => {
	const dir = mkdtempSync(join(tmpdir(), "gw-balancer-"));
	mkdirSync(join(dir, "dist", "node"), { recursive: true });
	writeFileSync(join(dir, "package.json"), "{\"type\": \"module\"}\n");
	writeFileSync(join(dir, "dist", "node", "api.js"), "export function balancerApi() { return \"api\"; }\n");
	const get = await loadBalancerApi([{ name: "balancer", requirePath: dir }]);
	assert.equal(get?.(), "api");
	assert.equal(await loadBalancerApi([]), undefined, "not in the plugin list");
	const missing = [{ name: "balancer", requirePath: join(dir, "missing") }];
	assert.equal(await loadBalancerApi(missing), undefined, "won't import");
});
