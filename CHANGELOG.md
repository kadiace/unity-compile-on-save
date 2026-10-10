# Change Log

All notable changes to the "unity-compile-on-save" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

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
