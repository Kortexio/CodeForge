/**
 * OpenCodeIDE - Main process entry (Electron shell placeholder)
 *
 * Full Code-OSS fork integration will replace this with the VS Code main process.
 * This stub allows packaging and smoke checks during early development.
 */

import { app, BrowserWindow } from 'electron';

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
    mainWindow = new BrowserWindow({
        width: 1280,
        height: 800,
        title: 'OpenCodeIDE',
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
        },
    });

    // Placeholder UI until Code-OSS workbench is wired
    void mainWindow.loadURL(
        'data:text/html;charset=utf-8,' +
            encodeURIComponent(`
        <!DOCTYPE html>
        <html>
          <head><title>OpenCodeIDE</title>
          <style>
            body { font-family: system-ui; background: #0f1419; color: #e6edf3;
                   display:flex; align-items:center; justify-content:center; height:100vh; margin:0; }
            .box { text-align:center; }
            h1 { font-weight: 600; letter-spacing: -0.02em; }
            p { opacity: 0.7; }
          </style>
          </head>
          <body>
            <div class="box">
              <h1>OpenCodeIDE</h1>
              <p>Embedded AI Platform — development shell</p>
              <p>AI Platform ready for integration with Code-OSS workbench.</p>
            </div>
          </body>
        </html>
      `)
    );

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

app.whenReady().then(() => {
    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});
