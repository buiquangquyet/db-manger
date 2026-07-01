import { app, BrowserWindow, shell } from 'electron';
import { join } from 'node:path';
import { registerIpc } from './ipc';

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'DB Manager',
    show: false,
    webPreferences: {
      // electron-vite build preload ra .mjs khi package.json có "type": "module".
      preload: join(__dirname, '../preload/index.mjs'),
      // Bảo mật: renderer không có quyền Node trực tiếp; chỉ qua preload/contextBridge.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.on('ready-to-show', () => win.show());

  // Mở link ngoài bằng trình duyệt hệ thống, không trong app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (devUrl) {
    void win.loadURL(devUrl);
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

app.whenReady().then(() => {
  registerIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
