// Always-on-top floating bar via the Document Picture-in-Picture API
// (Chromium 116+). Moves the live #app element into the PiP window, so all
// state, listeners and the canvas come along. Falls back to a small popup.

interface DocumentPictureInPicture {
  requestWindow(opts?: { width?: number; height?: number; disallowReturnToOpener?: boolean }): Promise<Window>;
  window: Window | null;
}

declare global {
  interface Window {
    documentPictureInPicture?: DocumentPictureInPicture;
  }
}

export interface PipHooks {
  onEnter(win: Window): void;
  onExit(): void;
}

export function pipSupported(): boolean {
  return 'documentPictureInPicture' in window;
}

export async function enterPip(app: HTMLElement, launcher: HTMLElement, hooks: PipHooks): Promise<boolean> {
  const api = window.documentPictureInPicture;
  if (!api) {
    // Fallback: a compact popup window (not always-on-top, but bar-shaped).
    window.open(location.href, 'agent-garden-bar', 'popup,width=320,height=660');
    return false;
  }
  const pip = await api.requestWindow({ width: 320, height: 660 });
  // Copy styles across.
  for (const sheet of [...document.styleSheets]) {
    // The world's stylesheet is re-attached by the shell when it re-mounts the world client.
    if ((sheet.ownerNode as HTMLElement | null)?.dataset?.worldCss) continue;
    try {
      const style = pip.document.createElement('style');
      style.textContent = [...sheet.cssRules].map((r) => r.cssText).join('\n');
      pip.document.head.appendChild(style);
    } catch {
      if (sheet.href) {
        const link = pip.document.createElement('link');
        link.rel = 'stylesheet';
        link.href = sheet.href;
        pip.document.head.appendChild(link);
      }
    }
  }
  pip.document.title = 'Agent Garden';
  pip.document.body.appendChild(app);
  launcher.hidden = false;
  hooks.onEnter(pip);
  pip.addEventListener('pagehide', () => {
    launcher.hidden = true;
    document.body.appendChild(app);
    hooks.onExit();
  });
  return true;
}

export function exitPip(): void {
  window.documentPictureInPicture?.window?.close();
}
