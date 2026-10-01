# Unity Compile on Save

Run `unity recompile` when you save a C# file in a Unity project from VS Code.

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

**Unity Compile on Save: Compile Unity on Save** is enabled by default (`true`). To disable it, add this to your VS Code `settings.json`:

```json
{
  "unityCompileOnSave.compileUnityOnSave": false
}
```

When enabled, saving a local `.cs` file runs `unity recompile` only if the file belongs to a Unity project (identified by `ProjectSettings/ProjectVersion.txt`) **whose root is open as a VS Code workspace folder**. Opening only a subfolder of a Unity project, or saving a file outside the open project, will not trigger recompilation. In a multi-root workspace, each open Unity project is handled separately. The extension passes `--project-path` to target the correct project. Saves within the same project are debounced for 200 ms, so consecutive saves trigger a single recompilation.
