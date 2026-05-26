const { app, BrowserWindow } = require("electron");
const fs = require("node:fs/promises");
const path = require("node:path");

async function capture() {
  const outputPath = process.argv[2] || path.join(__dirname, "..", "docs", "kctune-screenshot.png");
  const win = new BrowserWindow({
    width: 1512,
    height: 982,
    show: false,
    backgroundColor: "#08090d",
    webPreferences: {
      preload: path.join(__dirname, "..", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  await win.loadFile(path.join(__dirname, "..", "index.html"));
  await new Promise((resolve) => setTimeout(resolve, 900));
  const image = await win.webContents.capturePage();
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, image.toPNG());
  await app.quit();
}

app.whenReady().then(capture).catch(async (error) => {
  console.error(error);
  await app.quit();
  process.exit(1);
});
