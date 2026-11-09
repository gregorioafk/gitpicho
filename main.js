'use strict';
// App de escritorio: levanta el server embebido y lo muestra en una ventana propia.

const { app, BrowserWindow, Menu, shell, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { start } = require('./server');

// Puerto fijo para que el origen (y el localStorage de la UI) sea estable entre arranques.
const PREFERRED_PORT = 47777;

app.setName('gitpicho');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let win = null;
  let baseUrl = '';

  const stateFile = () => path.join(app.getPath('userData'), 'window.json');

  function loadBounds() {
    try {
      return JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    } catch {
      return { width: 1440, height: 900 };
    }
  }

  function saveBounds() {
    try {
      fs.writeFileSync(stateFile(), JSON.stringify({ ...win.getNormalBounds(), maximized: win.isMaximized() }));
    } catch {}
  }

  async function listen() {
    try {
      return await start(PREFERRED_PORT);
    } catch (e) {
      if (e.code !== 'EADDRINUSE') throw e;
      return start(0);
    }
  }

  function createWindow() {
    const { maximized, ...bounds } = loadBounds();
    win = new BrowserWindow({
      ...bounds,
      minWidth: 900,
      minHeight: 600,
      title: 'gitpicho',
      icon: path.join(__dirname, 'icon.png'),
      backgroundColor: '#1e1e2e',
      autoHideMenuBar: true,
      show: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    if (maximized) win.maximize();
    win.once('ready-to-show', () => win.show());
    win.on('close', saveBounds);

    // Cualquier link externo se abre en el navegador, nunca dentro de la app.
    win.webContents.setWindowOpenHandler(({ url }) => {
      shell.openExternal(url);
      return { action: 'deny' };
    });
    win.webContents.on('will-navigate', (e, url) => {
      if (!url.startsWith(baseUrl)) {
        e.preventDefault();
        shell.openExternal(url);
      }
    });
    win.loadURL(baseUrl);
  }

  const menu = Menu.buildFromTemplate([
    {
      label: 'App',
      submenu: [{ role: 'reload', label: 'Recargar' }, { role: 'toggleDevTools', label: 'Herramientas de desarrollo' }, { type: 'separator' }, { role: 'quit', label: 'Salir' }],
    },
    { label: 'Editar', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: 'Ver', submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
  ]);

  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  app.on('window-all-closed', () => app.quit());

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(menu);
    try {
      const port = await listen();
      baseUrl = `http://localhost:${port}/`;
      createWindow();
    } catch (e) {
      dialog.showErrorBox('gitpicho', `No se pudo iniciar el server: ${e.message}`);
      app.quit();
    }
  });
}
