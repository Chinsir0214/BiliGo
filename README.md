# BiliGo

BiliGo is a focused Windows desktop downloader for Bilibili, powered by Electron, yt-dlp, and ffmpeg.

## 1.5.1

- Fixed disabled field label shading, single-line ellipsis with hover tooltips for long select/path labels, and compact `1000x700` layout spacing so the download action stays visible.
- Preserved active-before-queued task order when restoring the download queue, centered toasts within the main workspace, rounded modal close focus rings, and refined sticky topbar separation.
- See [CHANGELOG.md](CHANGELOG.md) for the release history.

## 1.5.0 highlights

- Hardened Electron security and local file opening checks, tightened CSP, added single-instance locking, and switched local settings, history, and queue persistence to atomic writes with damaged-entry recovery.
- Added batch download enqueueing, safer workspace publishing with orphaned staging cleanup, process-tree termination with stall timeouts, `b23.tv` short-link expansion, single-part metadata fixes, and cookie verification before saving QR logins.
- Modularized the main and renderer processes, enabled Enter-to-parse and clear-history confirmation, deferred hidden thumbnail requests, and added `typecheck`, `verify:tools`, and expanded automated test coverage.

## 1.4.4 highlights

- The download center, history, settings, and dialogs now share a Windows UI font. Digits stay aligned as download progress and speed change.
- Navigation and controls use locally bundled Microsoft Fluent Regular icons, including in high-contrast mode.

## 1.4.3 highlights

- The download center opens sooner, especially when many tasks are saved in history.
- Large danmaku downloads and output file copies run in the background, keeping the interface responsive.
- The download center groups progress updates by frame and pauses rendering them while another view is open.

## 1.4.2 highlights

- Unified the look of the download center, task history, and settings with consistent buttons, form controls, and status indicators.
- Improved how download options, item lists, and task actions fit in smaller windows.
- Made keyboard focus easier to see, improved screen-reader labels, and hid broken cover and avatar images.

## 1.4.1 highlights

- Simplified the download screen and moved the form higher for quicker access.
- Clarified queue status and kept completion notifications from taking focus away from the current task.
- Improved assistive technology announcements and honored the system's reduced-motion preference.

## 1.4.0 highlights

- Fixed a login race when signing out and improved recovery for damaged queues and tasks saved by earlier versions.
- Fixed multi-part danmaku downloads and clarified error messages when a part cannot be downloaded.
- Kept audio-only attachment options and thread settings consistent, and refined empty states, settings, and dialog keyboard focus.
- Updated the bundled FFmpeg to the pinned October 2026 month-end build.

## 1.3.0 highlights

- Added persistent download settings and queue recovery after restarting the app.
- Improved task handling with configurable concurrency, collision-safe file publishing, and cleanup of failed or cancelled downloads.
- Improved account session handling and collection/favorite parsing, including unavailable favorite items.
- Added clearer download progress and error reporting, plus safer resource parsing and local file handling.

## Download

Download either Windows package from the [v1.5.1 release](https://github.com/Chinsir0214/BiliGo/releases/tag/v1.5.1).

- [BiliGo-Setup-1.5.1.exe](https://github.com/Chinsir0214/BiliGo/releases/download/v1.5.1/BiliGo-Setup-1.5.1.exe) installs BiliGo and includes an in-app update check.
- [BiliGo-1.5.1-portable.exe](https://github.com/Chinsir0214/BiliGo/releases/download/v1.5.1/BiliGo-1.5.1-portable.exe) runs without installation.

Both packages include the project-provided Windows builds of yt-dlp and ffmpeg. No separate tool installation is required.

## Run From Source

```bash
npm install
npm start
```

在新检出的 Windows 仓库中，先运行 `pwsh -File scripts/fetch-tools.ps1` 获取并校验 `tools/` 下的两个工具。工具版本和来源见 [tools/README.md](tools/README.md)。

Useful checks:

```bash
npm test
npm run check
npm run typecheck
npm run verify:tools
```

Build Windows packages:

```bash
pwsh -File scripts/fetch-tools.ps1
npm run dist
```

The build output is written to `release/` and is intentionally ignored by Git.
Windows CI runs the syntax check, tests, an unpacked Electron build, and verifies both bundled tool hashes in that build.

## Supported Content

- Single Bilibili videos using BV, AV, or `b23.tv` links
- Multi-part videos
- Bilibili collections
- Bilibili favorites, including authenticated favorites

Favorites load all items during parsing; unavailable items are shown but cannot be added to the download queue.

Available download content includes video plus audio, video only, audio only, cover images, subtitles, and danmaku. Audio/video merging and format conversion use the bundled ffmpeg executable.

Downloads are first written under `.biligo-staging` in the selected download directory. Completed files are published into place without overwriting existing files; name collisions receive a numbered suffix. Failed or cancelled tasks clean only their own temporary files. Interrupted tasks are restored from the local queue when the app starts again.

Resource parsing and login sessions live in separate modules. The yt-dlp metadata parser limits combined process output to 8 MiB, and the app checks local file paths and external links before opening them. The sidebar version comes from `package.json` through Electron.

## Privacy And Local Data

BiliGo does not upload personal settings, cookies, login data, history, or downloaded files to this repository or release.

- Login cookies are stored locally in the Electron user-data directory.
- Settings and task history are stored locally in the Electron user-data directory.
- Application logs are stored locally at `bili-go/logs/biligo.log` under the Electron user-data directory.
- Cookies, settings, history, local data directories, build output, and executables are excluded by `.gitignore`.
- The repository includes a pinned tool manifest. The Windows packages bundle the tool executables.

Review the `.gitignore` and `git status` before committing local changes.

## Logs

When a download fails, check:

```text
<Electron user-data>/bili-go/logs/biligo.log
```

Network access, login state, regional restrictions, and Bilibili anti-bot controls can affect parsing and downloads.

## License

BiliGo is distributed as-is for personal use. Bilibili content remains subject to the rights and terms applicable to that content.
