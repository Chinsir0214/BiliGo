# BiliGo

BiliGo is a focused Windows desktop downloader for Bilibili, powered by Electron, yt-dlp, and ffmpeg.

## 1.4.1

- Simplified the download screen and moved the form higher for quicker access.
- Clarified queue status and kept completion notifications from taking focus away from the current task.
- Improved assistive technology announcements and honored the system's reduced-motion preference.
- See [CHANGELOG.md](CHANGELOG.md) for the release history.

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

Download either Windows package from the [v1.4.1 release](https://github.com/Chinsir0214/BiliGo/releases/tag/v1.4.1).

- [BiliGo-Setup-1.4.1.exe](https://github.com/Chinsir0214/BiliGo/releases/download/v1.4.1/BiliGo-Setup-1.4.1.exe) installs BiliGo and supports in-app updates.
- [BiliGo-1.4.1-portable.exe](https://github.com/Chinsir0214/BiliGo/releases/download/v1.4.1/BiliGo-1.4.1-portable.exe) runs without installation.

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
```

Build Windows packages:

```bash
pwsh -File scripts/fetch-tools.ps1
npm run dist
```

The build output is written to `release/` and is intentionally ignored by Git.
Windows CI runs the syntax check, tests, an unpacked Electron build, and verifies both bundled tool hashes in that build.
The 1.4.0 release passed all 130 tests with zero skips.

## Supported Content

- Single Bilibili videos using BV or AV links
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
