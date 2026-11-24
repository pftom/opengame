# Run OpenGame from source

This guide installs the `OpenDesignHQ/opengame` checkout and connects its game tools to a local agent. Use the source checkout for the game workflow described in this repository.

## Prerequisites

- Git, npm and Node.js **26.11.1** (the CI version). `package.json` declares Node.js 22.18.0 or later.
- A local agent with stdio MCP support for AI-assisted creation. Browsing and playing bundled games does not require an agent connection.
- Chrome/Chromium for automated game screenshots and play-tests. Video trailers additionally require FFmpeg/ffprobe and the prepared export runtime.
- Media-provider credentials or an OpenDesign account only when using the corresponding generation or hosting services.

## Install and build

```sh
git -c filter.lfs.process= -c filter.lfs.smudge= -c filter.lfs.required=false clone --depth 1 --single-branch --branch main https://github.com/OpenDesignHQ/opengame.git
cd opengame
npm ci
npm run build:studio
```

The clone command skips optional large LFS media. The game templates and the README screenshots are ordinary Git files. Optional video resources have separate [storage instructions](repository-storage.md).

## Start a separate workspace

Keep project data outside the checkout. Use the same absolute data directory for Studio and MCP so the agent edits the games you see.

macOS / Linux:

```sh
MOTION_DATA_DIR="$HOME/.opengame/workspace" npm start
```

Windows PowerShell:

```powershell
$env:MOTION_DATA_DIR = Join-Path $env:USERPROFILE '.opengame\workspace'
npm start
```

Open the exact `previewUrl` returned by startup, then select **Game Studio**, or append `/game` to that origin. Do not assume a fixed port: the runtime may reuse a compatible service or select another free port.

Browse a template and play it. **Remix** creates an independent editable draft in the chosen workspace. In the integrated Studio, this action can immediately hand the task to the selected local Agent; ensure that the intended Agent and model are selected before starting. The service's draft-creation operation alone does not finish the game. An external-client handoff may instead provide instructions to continue in that client.

## Connect your local agent

Use your client's local stdio MCP configuration. The example below is the JSON format used by clients that support an `mcpServers` object; translate it into the native format for other clients. Replace all placeholder paths with absolute paths, including the Node executable returned by `command -v node` (macOS / Linux) or `(Get-Command node).Source` (PowerShell).

```json
{
  "mcpServers": {
    "opengame": {
      "command": "/absolute/path/to/node",
      "args": [
        "--experimental-strip-types",
        "/absolute/path/to/opengame/mcp.ts"
      ],
      "env": {
        "MOTION_DATA_DIR": "/absolute/path/to/.opengame/workspace"
      }
    }
  }
}
```

For Windows JSON, escape backslashes (`C:\\Users\\name\\...`) or use forward slashes. In this example, `opengame` is only the client-side connection label. The current public tool prefix remains **`openmotion_game_*`**, the game Skill remains **`openmotion-game`**, and the resource URI remains **`openmotion://workflow/game/start`**. Renaming these identifiers would prevent discovery or calls from matching this implementation.

Refresh MCP in the selected client. Ask the agent to discover its tools, read the game workflow resource and inspect the draft you selected. A saved configuration is not proof of an active connection; verify that `openmotion_game_get` can read that draft's exact ID in the intended workspace.

The [game Skill](../skills/openmotion-game/SKILL.md) is also available directly in the checkout. Installing Skill instructions does not install the application or connect MCP. A cloud-only client cannot reach a local stdio process through this configuration.

## Create and remix

Start from a template's **Remix** action or ask your connected agent to create a single-player game. Supply the target device, core action and visual direction. The agent should read the existing project before editing, implement the game, validate it and play-test the controls.

```text
Use the game workflow to create a portrait puzzle with five short levels.
The player sorts colored rings between poles. Add undo, a restart button
and clear touch controls. Use procedural graphics for this first version.
Validate and play-test it, then give me its local play link.
```

The game service exposes creation, reading, file edits, metadata, validation, simulation, play-testing, cover capture, status, local publication and gameplay trailers. See the current [tool schemas](../shared/game-tools.ts) for exact names and inputs.

## Generation and sharing

Configure only the providers you intend to use. Available models are discovered from the connected environment; paid image, music or voice generation uses the selected provider or account balance. See the [media workflow](../skills/openmotion-media/SKILL.md).

- **Local publication:** `openmotion_game_publish` lists the game in this workspace's catalog. A localhost URL is only reachable on the machine running it.
- **Public sharing:** the separate `openmotion_assets_use` operation with `action: "web_publish"` and `targetKind: "game"` publishes a static snapshot through an authenticated OpenDesign account and hosting workspace. Follow the [game sharing guide](../skills/openmotion-game/references/game-flow.md). Check the returned status and final URL; later local edits do not automatically update a published snapshot.
- **Multiplayer:** new creation is single-player. Existing local room-based projects keep their local server requirement; static hosting does not deploy that server.
- **Trailers:** gameplay capture and video export have additional Chrome/FFmpeg/runtime prerequisites. Automated captures do not establish sound quality, real-device performance or human gameplay acceptance.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| The agent cannot find the game | Match `MOTION_DATA_DIR` between Studio and the MCP process; use the selected draft's ID. |
| MCP has no game tools | Verify the source path points to this checkout's `mcp.ts`, then refresh discovery in the client. |
| A template cannot be edited | Use **Remix** to create an owned draft first. |
| Play works but automated capture fails | Check Chrome/Chromium availability and loopback access; ordinary play and server-side capture have different requirements. |
| A shared link still shows the previous version | Publish a new static snapshot through the sharing flow. |

[Back to OpenGame](../README.md)
