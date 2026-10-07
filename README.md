# Unity Compile on Save

Recompile Unity scripts when source files change in VS Code or on disk. Optionally refresh and recompile when the project environment changes.

## Highlights

- Recompile after supported C# and assembly input changes, including changes made by Git checkout, pull, stash pop, or other external tools.
- Keep recompilation scoped to Unity projects opened at their root in VS Code. Source changes are enabled by default; project environment changes are optional.
- Wait for a configurable quiet period (2 seconds by default), then wait for any ongoing Editor compilation to finish before sending one coalesced request.

## Getting started

1. Install **Unity CLI 1.0.0-beta.11 or later** using the [Unity CLI installation guide](https://docs.unity.com/en-us/unity-cli/use-unity-cli). Open a new terminal and run `unity --version` to check the installed version.
2. Open the project you want to recompile in the Unity Editor.
3. Install Unity Pipeline into that project. Replace the example path with the path to your Unity project.

```powershell
unity pipeline install --project-path "C:\path\to\UnityProject"
```

4. Wait for the Unity Editor to finish installing the package and compiling. Then run `unity pipeline list`. Your project is ready when it shows **Pipeline: Installed** and **Server: Connected**.
5. Open the **root folder** of the same Unity project in VS Code.

## Usage

The extension contributes four settings under **Unity Compile on Save**:

| Setting | Default | Effect |
| --- | --- | --- |
| **Recompile on Save** (`unityCompileOnSave.recompileOnSave`) | `true` | Master switch. Turning it off disables both triggers below. |
| **Recompile on Source Changes** (`unityCompileOnSave.recompileOnSourceChanges`) | `true` | Recompile after source or assembly input changes. |
| **Recompile on Project Environment Changes** (`unityCompileOnSave.recompileOnProjectEnvironmentChanges`) | `false` | Resolve packages when needed, refresh assets, then recompile after environment changes. |
| **Quiet Period Seconds** (`unityCompileOnSave.quietPeriodSeconds`) | `2` | Once a recompilation is pending, wait for this many seconds without any file change under `Assets/`, `Packages/`, or `ProjectSettings/` (0.2–60 seconds). |

For example, to enable project environment changes, add this to your VS Code `settings.json`:

```json
{
  "unityCompileOnSave.recompileOnProjectEnvironmentChanges": true
}
```

Source changes include creating, modifying, or deleting `.cs`, `.asmdef`, `.asmref`, `Assets/csc.rsp`, managed `.dll` files, and their `.dll.meta` files under `Assets/` or in-project `Packages/`. Project environment changes include `Packages/manifest.json`, `Packages/packages-lock.json`, in-project package `package.json` files, `ProjectSettings/ProjectSettings.asset`, and `.asset` files in `Assets/**/Build Profiles/`. Package changes invoke Unity Pipeline's `package_resolve` before `Assets/Refresh` and the explicit `unity recompile` command. Other environment changes invoke `Assets/Refresh` before recompilation. Unity can also compile scripts as part of package resolution itself.

Only local files in a Unity project (identified by `ProjectSettings/ProjectVersion.txt`) **whose root is open as a VS Code workspace folder** are handled. Opening only a subfolder or changing a file outside the open project does not trigger recompilation. Source and environment changes share one project-level quiet period. After an eligible change requests recompilation, **any file creation, modification, or deletion in `Assets/`, `Packages/`, or `ProjectSettings/` restarts the timer**, even when that file is not a compile trigger itself (for example, a texture). Such unrelated file changes alone never request recompilation. Changes under generated folders such as `Library/` and `Temp/` do not extend the wait. After the project stays unchanged for 2 seconds by default, the extension checks Unity Pipeline's `recompile_status` and waits if the Editor reports a compilation in progress. Changes received during that wait are merged into **one explicit recompile** after the Editor becomes idle. Changes arriving during a recompile initiated by this extension are also merged into one later request. A checkout followed by a pull is combined if the gap between watched changes is shorter than the configured quiet period; increase the setting if your workflow pauses longer. In a multi-root workspace, each Unity project is handled separately and targeted with `--project-path`. An explicitly configured legacy `unityCompileOnSave.compileUnityOnSave` value remains effective until **Recompile on Save** is configured.

## License

MIT. The full license text is included in the `LICENSE` file.
