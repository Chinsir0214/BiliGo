# Changelog

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
