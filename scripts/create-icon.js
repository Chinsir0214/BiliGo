const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');

app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 256, height: 256, useContentSize: true });
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
      <rect width="256" height="256" fill="#141414"/>
      <text x="128" y="190" text-anchor="middle" font-family="Arial Black, Arial, sans-serif" font-size="190" font-weight="900" fill="#fff">B</text>
    </svg>`;
  await window.loadURL(`data:text/html,<body style="margin:0;width:256px;height:256px">${encodeURIComponent(svg)}</body>`);
  const image = await window.webContents.capturePage({ x: 0, y: 0, width: 256, height: 256 });
  fs.mkdirSync(path.join(__dirname, '..', 'assets'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, '..', 'assets', 'icon.png'), image.toPNG());
  window.destroy();
  app.quit();
});
