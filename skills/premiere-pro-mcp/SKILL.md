---
name: premiere-pro-mcp
description: Install, verify, troubleshoot, and operate the Adobe Premiere Pro MCP server. Use when a user wants an agent to set up Premiere MCP, connect Claude Code/Codex/Claude Desktop, control Premiere, import media, build sequences, edit timelines, apply effects, or diagnose bridge issues.
---

# Adobe Premiere Pro MCP

Use this skill when working with the Adobe Premiere Pro MCP server from `hetpatel-11/Adobe_Premiere_Pro_MCP`.

## Core Rules

- Use the MCP tools for Premiere operations; do not invent ExtendScript unless the MCP tool surface is missing the needed operation.
- Default MCP `tools/list` is a small always-on set. Call `search_tools` (BM25 query or regex pattern), then `invoke_tool` with the exact name. `PREMIERE_MCP_TOOLSET=full` lists every tool.
- Prefer read-only discovery first: `get_project_info`, `list_sequences`, `list_project_items`, `get_active_sequence`, and relevant resource reads.
- Use real imported media. If the user asks to edit with assets, verify file paths exist, import them with `import_media`, then place the imported project item IDs on a sequence.
- Keep the temp directory consistent across the MCP server and CEP panel. When
  `PREMIERE_TEMP_DIR` is unset, the server uses
  `join(os.tmpdir(), 'premiere-mcp-bridge')`, which is
  `%TEMP%\premiere-mcp-bridge` on Windows; never assume the POSIX literal
  `/tmp` will resolve to the platform temp directory.
- Ask before destructive or externally visible actions: deleting clips/media, overwriting exports, closing projects, saving over important project files, or sending files elsewhere.
- Never force-terminate Premiere Pro or Adobe Media Encoder. Do not use
  `Stop-Process -Force`, `taskkill /F`, or equivalent. Adobe treats that as an
  unexpected exit and can show a recovery prompt on the next launch. If Premiere
  must be restarted, ask the user to quit it from the UI. `CloseMainWindow()` is
  allowed only with explicit user approval; if the process is still running,
  stop and ask again instead of escalating to force.
- For generated/demo edits, prefer creating a new clearly named sequence instead of modifying the user's active sequence.
- If a tool returns `success: false`, report the exact error and run diagnostics before retrying blindly.

## Fork Hardening

This fork keeps upstream compatibility and adds the following verified safety
rules. Apply them before editing or diagnosing a live project.

- `remove_from_timeline` defaults to `lift` and leaves a gap. Pass
  `deleteMode: "ripple"` only when downstream clips should move.
- `batch_apply_effect` requires a non-empty `clips` array, applies only to those
  clips, and fails the whole call before mutation when an id is unknown.
- `add_adjustment_layer` fails closed in this build. Create a real Adjustment
  Layer in Premiere and place it with the timeline tools instead of relying on a
  generated transparent PNG.
- Prefer `export_sequence`: AME is the default route when available, with
  `exportAsMediaDirect()` only as a fallback. On Windows, paths must use native
  backslashes. Pass `format` when the delivery format matters; when no preset is
  supplied it selects a matching installed AME system preset, and when a preset
  is supplied it rejects a preset/format conflict instead of silently writing a
  different container. If `format` is omitted, use the output extension when
  recognised, otherwise default to MP4/H.264. Inspect `method`,
  `directResult`, `outputExists`, the selected `presetResolution`, and the
  actual artifact after export.
- `export_sequence` / `add_to_render_queue` can submit several AME jobs in
  parallel, but AME encodes queued jobs sequentially by default. The job IDs
  returned by `encodeSequence` are submission receipts, not completion
  receipts. Wait for the artifact and probe the actual file.
- `get_encoder_presets` includes installed AME `systempresets` as well as user
  presets and reports `source`, `container`, `exporterFileType`, and
  `formatTags`. Preset names can repeat across containers (`H264` MP4 and
  QuickTime `MooV`), so pass `format` or an exact path to disambiguate.
- Legacy format aliases now select their first-party preset instead of a
  misleading same-name or audio-only preset: `dv` uses an `AVIV` video preset,
  `mpeg2` prefers `mpg2`, `wmv` excludes `Audio Only`, `pcm` uses `RawPCM`,
  and `gif` defaults to `Animated GIF`. `pcm` writes a headerless `.pcm` file;
  `gif` writes one animated `.gif`, not a GIF sequence.
- Host limits are reported explicitly instead of as successful exports:
  Adobe removed the FLV/F4V exporters, so a compatible FLV preset can fall
  back to AAC-only output on Premiere 25.x; the Premiere 25.x script API also
  returns a job ID for HEVC without writing an artifact. Use H.264 for the
  scripted path, or export FLV/HEVC manually in Premiere when that codec is
  required.
- The 32-format matrix was live-tested on 2026-10-07 with Premiere 25.4.0 and
  AME 25.6: 30 formats passed with `ffprobe`/bundle verification, FLV was
  host-limited, and HEVC was a known host API failure. Re-run the matrix after
  changing preset discovery or host versions.
- On Premiere 25.4, `app.project.save()` can return success while opening a
  modal that says the project directory is not writable. The local build saves
  with `saveAs(currentPath)` and verifies the file on disk. If an older build is
  installed, use `save_project_as` to a fresh path instead of retrying Ctrl+S.
- Media Encoder discovery is configurable. Use `PREMIERE_AME_PATH` or
  `ADOBE_AME_PATH` for an explicit executable/folder, and
  `PREMIERE_ADOBE_ROOT`, `ADOBE_ROOT`, or `ADOBE_HOME` for an Adobe install root
  that is outside the default Program Files locations.
- Premiere discovery and auto-launch are configurable too. Set
  `PREMIERE_EXE_PATH` to the exact executable, or `PREMIERE_INSTALL_ROOT` /
  `PREMIERE_ADOBE_ROOT` to an install root. The server also reads matching
  values from `<USER_HOME>\.codex\config.toml`. This is required when Premiere is
  installed outside `%ProgramFiles%\Adobe`.
- A long bridge command can make the panel heartbeat go stale after it was
  initially fresh. Treat that as busy, not as proof that the panel exited. Do not
  retry a render, batch, or destructive command until the panel reports
  `Connected` and the operation is still needed.
- `verify_premiere_connection.readOnly` is `null` with
  `readOnlySource: "unavailable"`. It is not a lock indicator; use
  `save_project_as` when saving is blocked.
- `execute_extendscript` wraps the body in an IIFE, so the script must `return`
  explicitly. Prefer a plain string result.
- Never commit bridge responses, project names, media paths, credentials,
  certificates, or machine-specific configuration. Keep bridge runtime state in
  an ignored local directory.

## Install Workflow

If the user asks you to install or set up the MCP:

1. Check the OS. The automated installer is macOS-focused.
2. Clone or open the repo:

```bash
git clone https://github.com/hetpatel-11/Adobe_Premiere_Pro_MCP.git
cd Adobe_Premiere_Pro_MCP
```

3. On macOS, run:

```bash
npm run setup:mac
```

4. For non-macOS or manual client setup, run:

```bash
npm install
npm run build
```

5. Register the MCP server in the user's client with:

```text
command: node /absolute/path/to/Adobe_Premiere_Pro_MCP/dist/index.js
env: PREMIERE_TEMP_DIR=/tmp/premiere-mcp-bridge
```

For Codex, prefer:

```bash
codex mcp add premiere_pro --env PREMIERE_TEMP_DIR=/tmp/premiere-mcp-bridge -- node /absolute/path/to/Adobe_Premiere_Pro_MCP/dist/index.js
```

## Premiere Bridge Startup

After installing:

1. Restart the MCP client if it reads config only at startup.
2. Restart Premiere Pro.
3. Open `Window > Extensions > MCP Bridge (CEP)`.
4. Set `Temp Directory` to `/tmp/premiere-mcp-bridge`.
5. Click `Save Configuration`.
6. Click `Start Bridge`.
7. Confirm the bridge panel says Premiere is ready before running editing tools.

If Premiere is not running, you can install/build/register the MCP, but tell the user live tool verification requires Premiere and the CEP bridge panel.

## Verification

Run local checks:

```bash
npm run setup:doctor
```

If Premiere is running and the bridge is started, verify with safe read-only calls:

- `get_project_info`
- `list_sequences`
- `list_project_items`

For deeper validation in a disposable project, create a test sequence with `create_sequence_from_clips` or `create_sequence` plus a real `.sqpreset` path, then call `list_sequences` and confirm it exists. Do not call blank sequence creation without a preset because newer Premiere versions can open a native dialog that blocks CEP.

## Editing Strategy

- Start by understanding the project: project info, active sequence, existing media, tracks, markers, and selected sequence.
- Build a plan in concrete Premiere operations before changing anything.
- For rough cuts, import media first, then use `create_sequence_from_clips` so Premiere derives settings without a native dialog. Use `create_sequence` only with a real `.sqpreset`; use `duplicate_sequence` with `clearContents=true` when an existing sequence defines the intended settings.
- For product or brand spots, prefer `assemble_product_spot` or `build_brand_spot_from_mogrt_and_assets` when the user's request fits those workflows.
- For black-and-white looks, use `apply_effect` with `Black & White` rather than generic saturation-only changes.
- For timeline cuts, prefer sequence-aware tools and include `sequenceId` when available.
- Export only after confirming output path, format/preset, and overwrite behavior.

## Troubleshooting

If commands time out or report bridge errors:

1. Confirm Premiere is open.
2. Confirm `Window > Extensions > MCP Bridge (CEP)` is open and bridge is started.
3. Confirm both sides use the same temp directory.
4. Run:

```bash
npm run setup:doctor
```

5. Ask the user to click `Run Diagnostics` in the CEP panel.
6. Read `/tmp/premiere-mcp-bridge/premiere-mcp-diagnostics-latest.json` if it exists.
7. Remove stale command/response files only if they are clearly old and the bridge is stopped or idle.

Common fixes:

- `ENOENT` on temp directory: create `/tmp/premiere-mcp-bridge`, save config again, restart bridge.
- Tool succeeds in Premiere but reports failure: run `list_sequences` or the relevant list tool to confirm state before retrying.
- Empty or malformed temp directory config: set the field to the path only, not JSON or an env assignment.

## Unexpected Exit While Opening a Project

Treat Adobe's "unexpectedly quit" or project-recovery prompt as an unclean
session, not as proof that the current project is corrupt.

1. Do not delete, replace, or auto-repair the project. Capture the exact dialog
   text, timestamp, and project path first.
2. Check `%LOCALAPPDATA%\Temp\NGL\NGLClient_PremierePro*.log`. A clean exit
   contains shutdown markers such as `Terminating session logs`; a log that
   stops without them is consistent with a crash or forced termination.
3. Check Windows `Application Error`, `Windows Error Reporting`, and
   `%LOCALAPPDATA%\CrashDumps`. If there is no Premiere user-mode crash record,
   do not claim that Premiere's code crashed.
4. Treat any prior `Stop-Process -Force`, `taskkill /F`, or Task Manager
   termination as the leading cause of the recovery prompt.
5. A missing source file normally marks that clip offline; it does not, by
   itself, explain an unexpected exit. Verify the `.prproj` decompresses as
   valid XML and check referenced media separately.

## Audio Output Device Warning On Project Open

Premiere can load the project successfully and then show a modal titled
`Premiere Pro`:

`没有可用的输出设备。是否要打开“音频硬件”首选项？`

- This is a Windows audio-endpoint warning, not a project crash or MCP failure.
  The timeline may already be loaded behind the dialog.
- Click `否` / `No` to dismiss it for this session. Do not enable
  `不再显示` / `Don't show again` without explicit user approval.
- Do not force-terminate Premiere to clear it.
- If the user wants to fix the cause, check for active render endpoints with
  `Get-PnpDevice -Class AudioEndpoint`. An empty result means Windows has no
  active output device, even when audio services and sound cards are present.
