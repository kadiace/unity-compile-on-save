# Native VS Code UI contract

## 1. Surface
Use the VS Code workbench's native StatusBarItem, not a webview or custom layout.
Reference: https://code.visualstudio.com/api/ux-guidelines/status-bar

## 2. Placement
One contextual item on the right side of the bottom status bar. Hide it outside
an opened Unity project or when connection display is disabled.

## 3. Theme
Inherit VS Code status bar typography, spacing, foreground, background, hover,
focus, and high-contrast treatment. Do not introduce custom colors or fonts.

## 4. Content
Use a short Unity connection label and at most one native codicon. In a
multi-root workspace, include the selected project name to distinguish roots.
Put the full project path and CLI readiness detail in the tooltip.

## 5. Primitive and states
The shared primitive is the native status bar item. States are Checking,
Connected, Busy, and Disconnected. Connected requires a successful project-scoped
Pipeline command response, not an installed package or running Editor process.
Busy means Pipeline responds but compilation is not idle.

## 6. Interaction
Click to run existing setup/reconnect for the displayed project only. Recheck
after setup/compilation, editor selection changes, and window focus. Periodic
checks must not flicker the existing label or overlap each other.

## 7. Accessibility
Expose a descriptive item name and accessible state/project label. Use text
alongside icons so connection state is not encoded by color alone.

## 8. Constraints and QA
The host owns resizing and item overflow. Verify connected/disconnected states,
project switching, tooltip, and click behavior in a real VS Code window. No
mobile/web redesign, decorative motion, or unrelated workbench customization.
