# Change Log

All notable changes to the "unity-compile-on-save" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

## [0.0.11]

- Hold pending automatic recompilation during worktree-changing Git commands observed in shell-integrated VS Code terminals, then restart the full quiet period after the last command ends. This prevents compilation during a long fetch between checkout and pull.
- Validate project-scoped C# Problems before automatic recompilation, allowing warnings and excluding previous Unity CLI compiler diagnostics.
- Retain and merge changes while language-server errors block compilation, then resume on diagnostic changes without extra CLI polling or bypassing the quiet period.

## [0.0.10]

- Serialize project recompilation requests and merge queued changes while preserving debounce and Pipeline setup ordering.
- Retain pending changes while the Editor is unavailable and resume when readiness recovers.
- Retry connection failures (exit code 7) at most twice, never retry compiler failures (exit code 6), and keep automatic failures in Output without notifications.
- Return structured operation results with CLI output, exit codes, and execution stages while preserving failure rejection and compiler Problems.

## [0.0.9]

- Run Unity CLI operations in the background and log stdout/stderr in the Unity CLI Output channel without creating terminals or taking focus.
- Show C# compiler errors and warnings in Problems and replace each project's diagnostics on recompilation.
- Offer a Show Log action on failures while preserving Pipeline connection, cancellation, and Editor process lifecycles.
- Replace setup/recompile task entries with Command Palette commands.
- Clearly disclose default automatic CLI installation, Pipeline package changes, Editor launch, recompilation, and connection checks, including opt-out settings.

## [0.0.8]

- Show project-scoped Unity Pipeline recompilation readiness in the VS Code status bar, with periodic connection checks and a reconnect action.
- Keep connection checks aligned with the CLI used for saves, select the most specific Unity root in nested workspaces, and show newly triggered recompilation as busy.
- Fix automatic setup waiting on output handles inherited by the launched Unity Editor, allowing saved changes to compile after cold startup.

## [0.0.7]

- Fix saves being ignored when neither the new nor legacy master setting was explicitly configured.
- Automatically provision Unity CLI 1.0.0-beta.11 or later, preferring stable releases for fresh installations, and connect Unity Pipeline when a trusted Unity project opens.
- Run setup and recompilation through discoverable VS Code tasks with progress, cancellation, and a reconnect command. Open the project's installed Editor when needed.
- Add an automatic setup opt-out for users who manage their own CLI and Pipeline.

## [0.0.6]

- Extend a pending quiet period on any file change in `Assets/`, `Packages/`, or `ProjectSettings/`, without treating unrelated files as compile triggers.

## [0.0.5]

- Wait for a configurable quiet period and an idle Unity Editor before requesting recompilation.
- Merge changes arriving during an Editor or extension-triggered compile into one follow-up request.

## [0.0.4]

- Added source and project environment change settings with shared recompilation debounce.
- Resolve packages and refresh assets before recompiling after relevant environment changes.
