# Gridworld v2

An infinite world of square tiles for Factorio 2.1, each tile its own Clusterio instance, joined by Universal Edges v2. The controller keeps one world record and creates, starts and connects tiles to match it: a tile starts when it's created and when a player joins next to it. Planets, corner crossings and shared daytime, plus four cross-border features (pollution, raids, expansion and evolution), each a controller config toggle.

## Requirements

- Clusterio 2.1, built from source: 2.1 isn't released yet, so a checkout of `master`. The plugin builds inside Clusterio's pnpm workspace. This version doesn't load on Clusterio 2.0, use commit `de17d68` of this plugin there.
- Node 22 or later, and pnpm at the version in Clusterio's `packageManager`.
- Universal Edges for Clusterio 2.1, cloned next to it (`external_plugins/universal_edges`).
- `zip` (UE's mod build), and `lua5.2` and `luacheck` (tests and lint).

## Install

In a Clusterio checkout:

```sh
git clone https://github.com/clusterio/universal_edges.git external_plugins/universal_edges
git clone -b v2 https://github.com/clusterio/gridworld.git external_plugins/gridworld
pnpm install
pnpm build
pnpm run -r --if-present prepare
```

`prepare` compiles the plugin and bundles its web page. Add the plugin to the controller's plugin list with `npx clusteriocontroller plugin add ./external_plugins/gridworld` and to each host's with `npx clusteriohost plugin add ./external_plugins/gridworld`, from the checkout (a path needs the `./`).

With the balancer plugin loaded, gridworld doesn't start a tile while it moves and places new tiles only on hosts it accepts; put balancer before gridworld in the plugin list. Without it, gridworld runs as it does alone.

## Test and lint

Run these from inside the Clusterio checkout, where Oxlint is installed:

```sh
pnpm --filter gridworld run test   # TypeScript and Lua unit tests; run prepare first
pnpm --filter gridworld run lint   # Oxlint with Clusterio's rules, and luacheck
```

Game tests (headless Factorio, the `*_game_test.lua` files) and multi-instance end-to-end tests run from the clusterio-v2 integration repo, which isn't public. The design documents that code comments cite by section (§) live there too.

## Licence

Blue Oak Model License 1.0.0, in `LICENSE.md`.
