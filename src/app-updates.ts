import { registerSW } from "virtual:pwa-register";

export const APP_UPDATE_EVENT = "app-update-available";
let applyUpdate: (() => Promise<void>) | undefined;
export let updateAvailable = false;

export function initializeAppUpdates(): void {
  const announceUpdate = () => {
    updateAvailable = true;
    window.dispatchEvent(new Event(APP_UPDATE_EVENT));
  };
  applyUpdate = registerSW({
    immediate: true,
    onNeedRefresh: announceUpdate,
    onRegisteredSW(_url, registration) {
      if (!registration) return;
      registration.addEventListener("updatefound", () => {
        const worker = registration.installing;
        worker?.addEventListener("statechange", () => {
          if (worker.state === "installed" && navigator.serviceWorker.controller) announceUpdate();
        });
      });
      const check = () => {
        if (navigator.onLine && !registration.installing) void registration.update().catch(() => {});
      };
      check();
      window.addEventListener("focus", check);
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") check();
      });
      window.setInterval(check, 60_000);
    },
  });
}

export async function installAppUpdate(): Promise<void> {
  await applyUpdate?.();
  window.location.reload();
}
