# BiliGo

基于 Electron、yt-dlp 和 ffmpeg 的 Bilibili 下载器。

## 运行

```bash
npm install
npm start
```

项目已经将 Windows 版 yt-dlp 与 ffmpeg 放在 `tools/` 目录中，用户无需再下载。应用会优先使用打包资源中的 `tools/`。

Windows 也可以把 `yt-dlp.exe` 和 `ffmpeg.exe` 放入 `tools/`。下载任务会优先使用这些内置文件，只有找不到时才回退到系统 PATH。
