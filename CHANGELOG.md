# Changelog

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
