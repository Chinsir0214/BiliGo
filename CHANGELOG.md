# Changelog

## 1.5.0

- Hardened local path and IPC validation: `shell:open` now requires an existing directory, `video:play-local` requires a regular playable media file, shell open errors are surfaced instead of ignored, CSP disables inline styles and external renderer connections, and Electron permission requests and webview attachments are blocked.
- Added single-instance locking, atomic JSON writes with backup fallback and Windows rename retries, per-item queue recovery that isolates damaged entries instead of halting the queue, and single-write batch task submission.
- Improved download workspace publishing, process lifecycle, danmaku decoding, and resource parsing: separated staging cleanup from commit failures, added cross-volume atomic copies and orphaned staging cleanup, added silent-stall timeouts and process-tree termination on cancel/quit, resolved `b23.tv` short links, preserved single-part titles and thumbnails, fixed SemVer prerelease update comparisons, and verified QR-login cookies before saving them to disk.
- Split the renderer and main process into focused ES and CommonJS modules, added Enter-to-parse form submission, confirmation before clearing history, on-demand thumbnail loading, accessibility and WCAG contrast fixes, and fixed toast stacking and retry/account/settings async races.
- Added recursive syntax checks (`npm run check`), TypeScript `checkJs` verification (`npm run typecheck`), tool hash verification (`npm run verify:tools`), expanded unit test coverage, and hardened CI and repository ignore rules.

## 1.4.4

- Unified Chinese and Latin text across the Windows interface with Microsoft YaHei UI, falling back to Microsoft YaHei or the system sans-serif. Download percentages, speeds, remaining times, and media durations use tabular digits for easier comparison.
- Replaced the icon font with nine bundled Microsoft Fluent Regular SVGs for navigation, actions, empty states, and form controls. The icons work offline and support Windows high-contrast mode. Bundled icon resources are about 860 KiB smaller.

## 1.4.3

- Opened the download center sooner by loading history and settings controls on demand and checking for updates after the first screen appears.
- Moved danmaku decompression and XML validation to reusable background threads so large downloads keep the interface responsive.
- Batched progress updates by frame and paused progress rendering while the download center is hidden.
- Moved large output file copies off the main thread. When quitting during a copy, BiliGo finishes saving the files and records the result before it exits.

## 1.4.2

- Unified the look of the download center, task history, and settings with consistent buttons, form controls, and status indicators.
- Improved how download options, item lists, and task actions fit in smaller windows.
- Made keyboard focus easier to see, improved screen-reader labels, and hid broken cover and avatar images.

## 1.4.1

- Simplified the download screen by removing the introductory banner and bringing the form closer to the top.
- Made queue status clearer for waiting, restored, and completed downloads, and kept completion notifications from interrupting the current task.
- Improved screen-reader announcements, made repeated notifications stay visible for their full duration, and reduced motion when requested by the system.

## 1.4.0

- Fixed a sign-in and sign-out race that could restore a previous login session after signing out.
- Preserved damaged download queue files for recovery and improved how interrupted tasks and task history from earlier versions are restored.
- Kept audio-only attachment options and download thread settings consistent between the download form, saved settings, and queued tasks.
- Fixed danmaku downloads for multi-part videos and clarified errors when a part's danmaku cannot be downloaded.
- Refined empty states and the settings layout, and made keyboard focus more predictable when opening and closing dialogs.
- Updated the bundled FFmpeg to the pinned October 2026 month-end build, restoring tool downloads for fresh checkouts and Windows CI.

## 1.3.0

- Added persistent download settings and queue recovery after restarting the app.
- Improved task handling with configurable concurrency, collision-safe file publishing, and cleanup of failed or cancelled downloads.
- Improved account session handling and collection/favorite parsing, including unavailable favorite items.
- Added clearer download progress and error reporting, plus safer resource parsing and local file handling.

## 1.2.0

- Added a more complete download queue with persisted tasks and configurable concurrency.
- Added support for single videos, multi-part videos, collections, and favorites.
- Added video, audio, cover, subtitle, and danmaku download modes.
- Added quality, container, filename, rate limit, retry, fragment-thread, and metadata options.
- Added QR-code login for content that requires an account.
- Added task history, retry, cancellation, local-file actions, and update checking.
- Improved validation, partial-file cleanup, progress reporting, and local path safety.
- Fixed collection URLs that also contain a BV id being treated as a single video.
