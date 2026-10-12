# Unity Compile on Save

Recompile Unity scripts when source files change in VS Code or on disk. Optionally refresh and recompile when the project environment changes.

## Automatic actions enabled by default

**Installing or enabling this extension while a trusted, local Unity project root is already open can start automatic setup immediately.** Otherwise, setup starts when that root is opened or added to the workspace, when workspace trust is granted, or when automatic setup/recompilation is re-enabled. The default settings enable automatic setup, source-change recompilation, and connection-status checks. The extension does not ask for an additional confirmation before automatic setup.

Automatic actions include:

- **Unity CLI discovery and installation:** run local CLI version checks; if no supported CLI is found, download and run Unity's official installer to install an extension-managed copy in VS Code's extension storage. This requires network access when installation is needed. Existing supported installations are reused; older system installations are not upgraded or replaced.
- **Project package changes:** run `unity pipeline install --project-path <root> --non-interactive`, which installs Unity Pipeline and modifies the project's Unity package dependencies.
- **Editor launch and connection:** check running Editors, open the project in its installed Unity Editor if needed, and query Pipeline readiness until the connection is ready. The extension does not install the Unity Editor or accept licenses on your behalf.
- **Compilation:** watch supported project files and run `unity recompile` after eligible saves or changes on disk, including changes made by Git or other tools. Project-environment triggers are disabled by default; enabling them can also resolve packages and refresh assets before recompilation.
- **Background CLI queries:** while connection status is enabled, query the selected project's readiness every five seconds and after operations or project-selection changes. These checks are separate from change-triggered recompilation.

These actions target local Unity projects whose root is open as a workspace folder and require workspace trust. Automatic setup additionally requires **Auto Setup** and **Recompile on Save** to be enabled. Logs are available in **Output → Unity CLI**; the extension does not create terminals.

### Choose the automatic behavior before opening a Unity workspace

Set `unityCompileOnSave.autoSetup` to `false` in **User Settings before installing/enabling the extension or opening/trusting a Unity workspace** to prevent automatic CLI provisioning, Pipeline installation, and Editor launch. Automatic recompilation then uses the `unity` command already on your PATH and a Pipeline connection you manage yourself.

To disable all three automatic behaviors, use:

```json
{
  "unityCompileOnSave.autoSetup": false,
  "unityCompileOnSave.recompileOnSave": false,
  "unityCompileOnSave.showConnectionStatus": false
}
```

Disabling **Recompile on Save** also prevents automatic setup, but does not by itself disable connection-status queries. Explicit setup/recompile commands remain available; choosing **Set Up / Reconnect Unity Pipeline** can still install the CLI/Pipeline and open the Editor even when automatic setup is disabled. Restricted Mode and virtual workspaces do not run installation or compilation.

## Highlights

- Recompile after supported C# and assembly input changes, including changes made by Git checkout, pull, stash pop, or other external tools.
- Keep recompilation scoped to Unity projects opened at their root in VS Code. Source changes are enabled by default; project environment changes are optional.
- Wait for a configurable quiet period (2 seconds by default), then wait for any ongoing Editor compilation to finish before sending one coalesced request.
- Defer automatic recompilation while VS Code reports C# errors in the target Unity project, then resume the pending changes automatically when those errors clear.

## Getting started

1. Install **Unity Compile on Save** from the VS Code Marketplace.
2. Open the **root folder** of your Unity project in VS Code and trust the workspace.
3. The extension automatically connects **Unity Pipeline** in the background. It finds a supported Unity CLI or installs an extension-managed copy without administrator privileges. Fresh installations default to **1.0.0-beta.13**. Existing installations must be **1.0.0-beta.13 or later** to be reused.

Before recompiling, the extension checks `unity status --format json` for the current project. A reported blocking modal dialog skips that request without an error notification; its reason and dialog titles are recorded in the **Unity CLI** Output channel. If the status query fails, the existing recompilation flow continues. A later change or manual Recompile request can try again after the dialog is closed.
4. Setup runs `unity pipeline install --project-path <root>`, opens the project in its installed Unity Editor if it is not already running, and waits for the Pipeline connection. Save a C# file after setup; recompilation runs automatically after the quiet period.

No `.vscode/tasks.json` or manual CLI installation is required. First-time setup needs no VS Code restart; updating an already active extension may require **Developer: Reload Window** as described below. Existing supported CLI installations are reused; older system installations are left untouched. Automatic setup requires internet access for downloads, a compatible installed and licensed **Unity 6+ Editor**, and any Unity sign-in required by your environment. It does not install the Unity Editor, accept licenses, or bypass authentication. Pipeline installation modifies the project's Unity package dependencies.

All Unity CLI commands, including Pipeline setup and connection checks, send stdout/stderr to the **Unity CLI** Output channel. Commands stream logs as they run; the Editor launcher collects its output separately and publishes it on launcher exit so inherited Editor handles remain valid. C# compiler errors and warnings appear in **Problems**, with file paths, line/column locations, and compiler codes. Each actual recompilation replaces that project's previous diagnostics without clearing other projects' Problems; waiting for an unavailable Editor does not clear them. Readiness checks log their responses but do not republish historical compilation errors. Automatic failures are recorded only in Output and never open a panel or notification. Final failures of explicit commands offer **Show Log**, which reveals Output only when selected, without taking editor or terminal focus. No extension operation creates a terminal.

An unavailable Editor leaves detected changes pending, with readiness checked again every five seconds, even when connection-status display is disabled. Once ready, the coalesced request runs. A direct recompile connection error (exit code 7) permits at most two retries, checking readiness before each; compiler errors (exit code 6) are never retried. A lost post-compilation connection is reported as a connection failure, not success, and does not repeat an already successful invocation. Queued requests for the same project merge their change kinds; an explicit Pipeline setup remains an ordering barrier.

### Pre-compilation validation

Before automatic recompilation checks Editor readiness, the extension inspects the current VS Code Problems for C# files in the target Unity project. Any `Error` from external diagnostics, including the C# language server, keeps the changes pending. `Warning`, non-C# Problems, errors in other projects (including separately opened nested Unity projects), and this extension's previous `Unity CLI` compiler diagnostics do not block it. The extension checks again immediately before requesting recompilation in case errors arrived during the readiness wait.

While blocked by C# errors, the automatic recompilation handler makes no CLI readiness or recompilation calls and does not poll for diagnostic changes. When VS Code updates or removes those Problems and all blocking errors are gone, the handler resumes the coalesced pending request without requiring another save. File changes still merge their source/package/environment kinds and restart the existing quiet period; clearing errors never bypasses that period. Disabling automatic recompilation or removing the project cancels its retained work. Independent connection-status queries and automatic setup keep their existing behavior. The explicit **Recompile Unity** command remains available even when language-server errors are present.

For programmatic callers, the existing setup and recompile commands return an array of project results. Each result includes `status` (`success`, `compile-failure`, `connection-failure`, `deferred`, `operation-failure`, or `cancelled`), the actual numeric `exitCode` when available (otherwise 1), `stdout`, `stderr`, `message`, `stage`, `recompileAttempts`, `packagesResolved`, `projectRoot`, and `operation`. `deferred` means readiness was unavailable before execution, not that compilation succeeded. The exported runner's `request()` returns these outcomes without rejecting expected operational failures. Its existing `execute()` still rejects failures, with the structured result available as `OperationError.result`; `onDidComplete` retains its project, operation, and exit-code fields and includes the additional result fields.

To retry setup or reconnect after a failure, run **Unity Compile on Save: Set Up / Reconnect Unity Pipeline** from the Command Palette. To compile manually, run **Unity Compile on Save: Recompile Unity**. These commands replace the previous **Tasks: Run Task** entries so even explicit operations do not create task terminals; remove any old `unityCompileOnSave` entries from `.vscode/tasks.json` and use the commands instead. Source changes received during setup are coalesced and compiled after the Editor becomes ready. Disabling **Recompile on Save** before opening a workspace prevents automatic setup. Restricted Mode and virtual workspaces do not run installation or compilation.

### Updating from task-based versions

Version **0.0.8 and earlier** run recompilation as a VS Code task. They create a **Recompile Unity** terminal and reveal it on failure. Version **0.0.9** runs CLI processes directly and uses **Output → Unity CLI** instead. Generating or downloading a VSIX does not install it.

If Git checkout/pull or a save still creates a recompile terminal, check the installed version in the affected VS Code profile:

```powershell
code --list-extensions --show-versions
code --install-extension "C:\path\to\unity-compile-on-save-0.0.9.vsix" --force
```

Verify `kadiace.unity-compile-on-save@0.0.9`, then run **Developer: Reload Window** in each already-open Unity workspace window to replace its old extension host. If using a named VS Code profile, pass `--profile "Profile Name"` to the commands above. Close any old task terminal yourself and remove obsolete `unityCompileOnSave` task entries from `.vscode/tasks.json`; the new runner does not use them. Failed automatic compiles leave the existing terminal active and report compiler diagnostics in **Problems**; only an explicit command's final failure shows a notification with **Show Log**.

### Manual setup / troubleshooting

Set `unityCompileOnSave.autoSetup` to `false` if you manage the CLI and Pipeline yourself. Automatic recompilation then uses `unity` from your existing PATH without provisioning tools or changing project dependencies.

The following commands are still useful when diagnosing an existing installation:

1. Install **Unity CLI 1.0.0-beta.13 or later** using the [Unity CLI installation guide](https://docs.unity.com/en-us/unity-cli/use-unity-cli). If Unity CLI is already installed but older than beta.13, upgrade it to the minimum supported version:

   ```powershell
   unity upgrade --target 1.0.0-beta.13
   unity --version
   ```

   Open a new terminal if the version has not updated. If you installed Unity CLI through a package manager other than winget, update it through that package manager instead of `unity upgrade`.
2. Open the project you want to recompile in the Unity Editor.
3. Install Unity Pipeline into that project. Replace the example path with the path to your Unity project.

   ```powershell
   unity pipeline install --project-path "C:\path\to\UnityProject"
   ```

4. Wait for the Unity Editor to finish installing the package and compiling. Then run `unity pipeline list`. Your project is ready when it shows **Pipeline: Installed** and **Server: Connected**.
5. Open the **root folder** of the same Unity project in VS Code.

## Usage

The bottom status bar shows **Unity: Connected** only when Unity CLI can query recompilation readiness through the currently selected project's Pipeline. **Busy** means Pipeline responds but compilation is in progress; **Disconnected** means readiness could not be confirmed. It checks every five seconds and after operation completion or project selection changes. Hover to see the exact project path, or click to set up/reconnect that project. In multi-root workspaces the active editor selects the project; outside a Unity project the item is hidden. Disable `unityCompileOnSave.showConnectionStatus` to hide it.

The extension contributes the following settings under **Unity Compile on Save**:

| Setting | Default | Effect |
| --- | --- | --- |
| **Auto Setup** (`unityCompileOnSave.autoSetup`) | `true` | Automatically provision Unity CLI, install Pipeline into the project, and open/connect the installed Editor when Recompile on Save is enabled. Explicit setup remains available when disabled. |
| **Show Connection Status** (`unityCompileOnSave.showConnectionStatus`) | `true` | Show status and run background CLI readiness queries every five seconds. Independent of the recompilation master switch. |
| **Recompile on Save** (`unityCompileOnSave.recompileOnSave`) | `true` | Master switch for both change triggers and automatic setup. Does not disable connection-status queries or explicit commands. |
| **Recompile on Source Changes** (`unityCompileOnSave.recompileOnSourceChanges`) | `true` | Recompile after source or assembly input changes. |
| **Recompile on Project Environment Changes** (`unityCompileOnSave.recompileOnProjectEnvironmentChanges`) | `false` | Resolve packages when needed, refresh assets, then recompile after environment changes. |
| **Quiet Period Seconds** (`unityCompileOnSave.quietPeriodSeconds`) | `2` | Once a recompilation is pending, wait for this many seconds without any file change under `Assets/`, `Packages/`, or `ProjectSettings/` (0.2–60 seconds). Observed terminal Git operations pause the timer and restart it on completion. |

For example, to enable project environment changes, add this to your VS Code `settings.json`:

```json
{
  "unityCompileOnSave.recompileOnProjectEnvironmentChanges": true
}
```

Source changes include creating, modifying, or deleting `.cs`, `.asmdef`, `.asmref`, `Assets/csc.rsp`, managed `.dll` files, and their `.dll.meta` files under `Assets/` or in-project `Packages/`. Project environment changes include `Packages/manifest.json`, `Packages/packages-lock.json`, in-project package `package.json` files, `ProjectSettings/ProjectSettings.asset`, and `.asset` files in `Assets/**/Build Profiles/`. Package changes invoke Unity Pipeline's `package_resolve` before `Assets/Refresh` and the explicit `unity recompile` command. Other environment changes invoke `Assets/Refresh` before recompilation. Unity can also compile scripts as part of package resolution itself.

Only local files in a Unity project (identified by `ProjectSettings/ProjectVersion.txt`) **whose root is open as a VS Code workspace folder** are handled. Opening only a subfolder or changing a file outside the open project does not trigger recompilation. Source and environment changes share one project-level quiet period. After an eligible change requests recompilation, **any file creation, modification, or deletion in `Assets/`, `Packages/`, or `ProjectSettings/` restarts the timer**, even when that file is not a compile trigger itself (for example, a texture). Such unrelated file changes alone never request recompilation. Changes under generated folders such as `Library/` and `Temp/` do not extend the wait. After the project stays unchanged for 2 seconds by default, the extension checks Unity Pipeline's `recompile_status` and waits if the Editor reports a compilation in progress. Changes received during that wait are merged into **one explicit recompile** after the Editor becomes idle. Changes arriving during a recompile initiated by this extension are also merged into one later request. Filesystem-only change bursts are combined if the gap between watched changes is shorter than the configured quiet period; observed terminal Git operations also hold pending work as described below. In a multi-root workspace, each Unity project is handled separately and targeted with `--project-path`. An explicitly configured legacy `unityCompileOnSave.compileUnityOnSave` value remains effective until **Recompile on Save** is configured.

### Git operations and the quiet period

A file quiet period alone does not mean Git has finished. In particular, `git pull` can spend longer than two seconds fetching without writing any watched project files, allowing a checkout's timer to expire during the pull.

For direct `git` / `git.exe` commands in a VS Code terminal with **shell integration**, the extension tracks worktree-changing operations such as `checkout`, `switch`, `pull`, `merge`, and `rebase`. While an observed operation affects the project's repository, pending changes are merged without starting new Editor readiness checks or requesting automatic recompilation. After the last operation ends, the full configured quiet period starts again. Thus, a checkout followed by a pull that starts before that period expires produces one coalesced request after the pull finishes, even if fetching takes much longer than two seconds. Normal file changes, C# error validation, and request merging still apply. Git activity alone never requests compilation, and separate repositories are not held together. Direct commands with `-C` and `-c` are supported; closing the terminal releases its hold.

This lifecycle guard cannot observe commands in **external terminals**, VS Code's **Source Control UI**, terminals without shell integration or a reported local working directory, or arbitrary aliases/wrapper scripts. Those paths retain filesystem-only debounce behavior. A pause longer than the quiet period between checkout completion and starting pull can still produce two compilations; the extension cannot predict a future command or retract a request already submitted. Unity's own **Auto Refresh / Directory Monitoring** can independently compile changed scripts: if there is no corresponding `unity recompile` invocation in **Output → Unity CLI**, the compile was not requested by this extension and this guard cannot prevent it.

### Git changes and scene reload

Script recompilation, asset import/refresh, and reopening an already-open scene are different operations. **This extension does not automatically reload `.unity` scenes after Git checkout/pull.** Scene-only changes do not request a compile; a scene change received alongside a source change extends the quiet period but does not add a scene-reload step. The existing environment/package path invokes `Assets/Refresh`, which is not a guarantee that the open scene is reloaded from disk.

Unity CLI **1.0.0-beta.11** with Pipeline **0.8.0-exp.1** exposes `list_open_scenes` and `open_scene`; `eval` can also call `UnityEditor.SceneManagement.EditorSceneManager.OpenScene`. A guarded `eval` was verified to reopen a clean, saved, single scene in idle Edit Mode. Before reloading, inspect **every** open scene's dirty state. Do not automatically save old in-memory scenes after a checkout: that can overwrite the newly checked-out files. Refuse automatic reload when there are unsaved changes, an unsaved scene, Play Mode, or an active Prefab Stage.

For a deliberately chosen **single-scene** workflow:

```powershell
$project = "C:\path\to\UnityProject"
unity command --project-path $project list_open_scenes --result-only
unity command --project-path $project menu "Assets/Refresh"
unity command --project-path $project recompile_status --json
```

Refresh may itself trigger compilation/domain reload. Wait until readiness reports `idle`, `completed`, or `up_to_date`, then recheck `list_open_scenes`. Only after confirming a clean, saved scene in idle Edit Mode, reopen its on-disk path:

```powershell
unity command --project-path $project open_scene --path "Assets/Scenes/Main.unity"
```

`open_scene` defaults to non-additive opening and replaces the open scene setup. Do not use it blindly for multi-scene editing or dirty scenes. For automated use, perform the state checks and reopen in one Editor-side operation so state cannot change between the safety check and the reload. Scene reload does not fix genuine C# compilation errors; review those separately in **Problems** and **Unity CLI** logs.

## License

MIT. The full license text is included in the `LICENSE` file.
