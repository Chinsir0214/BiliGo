# BiliGo

BiliGo is a focused Windows desktop downloader for Bilibili, powered by Electron, yt-dlp, and ffmpeg.

## 1.2.0

- Added a more complete download queue with persisted tasks and configurable concurrency.
- Added support for single videos, multi-part videos, collections, and favorites.
- Added video, audio, cover, subtitle, and danmaku download modes.
- Added quality, container, filename, rate limit, retry, fragment-thread, and metadata options.
- Added QR-code login for content that requires an account.
- Added task history, retry, cancellation, local-file actions, and update checking.
- Improved validation, partial-file cleanup, progress reporting, and local path safety.
- Fixed collection URLs that also contain a BV id being treated as a single video.

## Download

Download the Windows installer or portable executable from the [1.2.0 release](https://github.com/Chinsir0214/BiliGo/releases/tag/v1.2.0).

- `BiliGo Setup 1.2.0.exe`: installer with an optional desktop shortcut.
- `BiliGo-1.2.0-portable.exe`: portable build with no installation step.

Both packages include the project-provided Windows builds of yt-dlp and ffmpeg. No separate tool installation is required.

## Run From Source

```bash
npm install
npm start
```

Useful checks:

```bash
npm test
npm run check
```

Build Windows packages:

```bash
npm run dist
```

The build output is written to `release/` and is intentionally ignored by Git.

## Supported Content

- Single Bilibili videos using BV or AV links
- Multi-part videos
- Bilibili collections
- Bilibili favorites, including authenticated favorites

Available download content includes video plus audio, video only, audio only, cover images, subtitles, and danmaku. Audio/video merging and format conversion use the bundled ffmpeg executable.

## Privacy And Local Data

BiliGo does not upload personal settings, cookies, login data, history, or downloaded files to this repository or release.

- Login cookies are stored locally in the Electron user-data directory.
- Settings and task history are stored locally in the Electron user-data directory.
- Application logs are stored locally at `bili-go/logs/biligo.log` under the Electron user-data directory.
- Cookies, settings, history, local data directories, build output, and executables are excluded by `.gitignore`.
- The repository only contains source code, package metadata, and the explicitly bundled runtime tools.

Review the `.gitignore` and `git status` before committing local changes.

## Logs

When a download fails, check:

```text
<Electron user-data>/bili-go/logs/biligo.log
```

Network access, login state, regional restrictions, and Bilibili anti-bot controls can affect parsing and downloads.

## License

BiliGo is distributed as-is for personal use. Bilibili content remains subject to the rights and terms applicable to that content.
