# Bundled tools

只有 Windows x64（`win32-x64`）提供自动拉取与官方工具校验。脚本从 yt-dlp 和 FFmpeg-Builds 的发布页下载工具，按项目清单中的 SHA-256 校验后将 `yt-dlp.exe` 和 `ffmpeg.exe` 放入 `tools/`，供 Windows 打包使用。[版本与校验值](tool-versions.json)

macOS 和 Linux 需手动下载适合目标系统和架构的二进制，核对对应发布方提供的校验值，将程序命名为 `yt-dlp` 和 `ffmpeg` 放入 `tools/`，并赋予执行权限。

在项目根目录运行 PowerShell 命令即可准备 Windows 工具。

```powershell
pwsh -File scripts/fetch-tools.ps1
```

脚本发现本地文件哈希正确时直接复用，否则下载到临时目录，校验下载包及解出的程序后放入 `tools/`。仅校验已有文件（不会联网）：

```powershell
pwsh -File scripts/fetch-tools.ps1 -VerifyOnly
```

当前 Windows x64 工具：

- `yt-dlp.exe`: 2026.08.19，来自 [yt-dlp 官方发布](https://github.com/yt-dlp/yt-dlp/releases/tag/2026.08.19)，SHA-256 `66674953fe251b89f4d08c5f0e35e0728679bd67ab3d7d05c0562af101dd3e7a`。
- `ffmpeg.exe` 为 `N-128227-g4811625b5f-20261031`。下载包 `ffmpeg-N-128227-g4811625b5f-win64-gpl.zip` 的 SHA-256 是 `3a5cdb3b83dd1b62b29d946d3655a14d787e5e81d947ad68202a1a400095d2f8`，解出的 `ffmpeg.exe` SHA-256 是 `63f7cad2da68519366eee578ee2bcebb09b2bde58b06a410ef4bbf4fc00e2d2c`。[2026-10-31 Windows x64 GPL 静态构建](https://github.com/FFmpeg-Builds/FFmpeg-Builds/releases/tag/autobuild-2026-10-31-12-59)

Git 忽略 `tools/*.exe`。新检出仓库构建 Windows 发行版时，先运行工具下载脚本，再执行 `npm run dist`。清单固定了 FFmpeg 月末构建的发布标签与校验值。上游保留月末构建两年。标签过期后，需要更新清单中的下载地址和校验值，已有的本地文件通过校验后仍可使用。[FFmpeg-Builds 发布保留策略](https://github.com/FFmpeg-Builds/FFmpeg-Builds#release-retention-policy)
