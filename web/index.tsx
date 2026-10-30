import React, { useCallback, useContext, useEffect, useState } from "react";
import { Button, Descriptions, InputNumber, Popconfirm, Space, Table } from "antd";
import {
	ControlContext, PageHeader, PageLayout, notifyErrorHandler, useAccount, type WebPluginContext,
} from "@clusterio/web_ui";
import { WorldCreateRequest, WorldDeleteRequest, WorldGetRequest } from "../world/contracts.js";

type Shown = Awaited<ReturnType<typeof sendGet>>;

function sendGet(control: React.ContextType<typeof ControlContext>) {
	return control.send(new WorldGetRequest());
}

/**
 * v1's page controls (D30; v1 gridworld/web/index.tsx:331-350): Refresh, Create and a confirmed Delete, over SP2's
 * world requests. ponytail: no map, which moved to the map plugin; no live subscription, Refresh reloads.
 */
function GridworldPage() {
	const control = useContext(ControlContext);
	const account = useAccount();
	const [shown, setShown] = useState<Shown>();
	const [busy, setBusy] = useState(false);
	const [tileSize, setTileSize] = useState<number | null>(512);
	const [seed, setSeed] = useState<number | null>(null);
	const canManage = account.hasPermission("gridworld.manage") === true;
	const world = shown?.layout?.world;

	const load = useCallback(() => {
		sendGet(control).then(setShown).catch(notifyErrorHandler("Loading the gridworld failed"));
	}, [control]);
	useEffect(load, [load]);

	async function act(request: WorldCreateRequest | WorldDeleteRequest, failed: string) {
		setBusy(true);
		await control.send(request).catch(notifyErrorHandler(failed));
		setBusy(false);
		load();
	}

	return <PageLayout nav={[{ name: "Gridworld" }]}>
		<PageHeader
			title="Gridworld"
			extra={<Space>
				<Button onClick={load} disabled={busy}>Refresh</Button>
				{canManage && <>
					{!world && <>
						<InputNumber
							addonBefore="Tile size" min={64} max={4096} step={64} precision={0}
							value={tileSize} onChange={setTileSize}
						/>
						<InputNumber
							addonBefore="Seed" placeholder="random" min={0} max={4294967295} precision={0}
							value={seed} onChange={setSeed}
						/>
					</>}
					<Button
						type="primary"
						loading={busy}
						disabled={Boolean(world)}
						onClick={() => act(
							new WorldCreateRequest(
								tileSize ?? undefined, undefined, undefined, undefined, seed ?? undefined,
							),
							"Creating the gridworld failed",
						)}
					>
						Create new gridworld
					</Button>
					<Popconfirm
						title="Delete the entire gridworld?"
						description="This deletes all gridworld instances and edges."
						okText="Delete"
						okButtonProps={{ danger: true }}
						onConfirm={() => act(new WorldDeleteRequest(true), "Deleting the gridworld failed")}
					>
						<Button danger disabled={busy || !world}>Delete gridworld</Button>
					</Popconfirm>
				</>}
			</Space>}
		/>
		{world ? <Descriptions size="small" bordered column={2} style={{ marginBottom: 16 }}>
			<Descriptions.Item label="World">{world.id}{world.deleting ? " (deleting)" : ""}</Descriptions.Item>
			<Descriptions.Item label="Surface">{world.surface}</Descriptions.Item>
			<Descriptions.Item label="Tile size">{world.tileSize}</Descriptions.Item>
			<Descriptions.Item label="Created">{new Date(world.createdAtMs).toLocaleString()}</Descriptions.Item>
		</Descriptions> : <p>{shown ? "No gridworld." : "Loading…"}</p>}
		<Table
			size="small"
			dataSource={shown?.tiles ?? []}
			rowKey={t => `${t.x},${t.y}`}
			columns={[
				{ title: "Tile", key: "tile", render: (_, t) => `${t.x},${t.y}` },
				{ title: "Instance", key: "instance", render: (_, t) => t.instanceId ?? "-" },
				{ title: "Host", key: "host", render: (_, t) => t.host ?? "-" },
				{ title: "Status", key: "status", render: (_, t) => t.status ?? "no instance" },
				{ title: "Planets", key: "planets", render: (_, t) => t.planets?.join(", ") || "-" },
			]}
		/>
	</PageLayout>;
}

/** The web entry point (the pin's function form, packages/create/templates/plugin-ts/web/plugin.tsx:55-75). */
export default async function loadWebPlugin(context: WebPluginContext) {
	context.control.hooks.pages.attach(context.plugin.name, () => [
		{
			path: "/gridworld",
			sidebarName: "Gridworld",
			// Client side only: the controller checks each request's own permission.
			permission: "gridworld.view",
			content: <GridworldPage />,
		},
	]);
}
