import { invoke } from "@tauri-apps/api/core";

export const isTauriEnvironment = (): boolean => {
  return (
    typeof window !== "undefined" &&
    (Boolean((window as any).isTauri) ||
      Boolean((window as any).__TAURI_INTERNALS__) ||
      Boolean((window as any).__TAURI__))
  );
};

export const isMiniWindow = (): boolean => {
  if (typeof window === "undefined") return false;
  const urlParams = new URLSearchParams(window.location.search);
  return urlParams.get("mode") === "mini";
};

export const openMiniWindow = async (): Promise<void> => {
  if (!isTauriEnvironment()) {
    throw new Error("Mini Mode доступен только в десктопном приложении.");
  }
  await invoke("open_mini_window");
};

export const restoreMainWindow = async (meetingId?: string): Promise<void> => {
  if (!isTauriEnvironment()) {
    if (meetingId) window.location.assign(`/?meeting=${encodeURIComponent(meetingId)}`);
    return;
  }
  await invoke("restore_main_window", { meetingId: meetingId || null });
};
