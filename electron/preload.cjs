/**
 * The only bridge between the page and the app shell.
 *
 * Deliberately tiny: the renderer gets one function, `kraf.quit()`, used by the Esc
 * key on the main menu. Nothing else of Electron is exposed, so the page stays as
 * sandboxed as an ordinary web page.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('kraf', {
  quit: () => ipcRenderer.send('kraf:quit'),
});
