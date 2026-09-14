import { saveAs } from "file-saver";
import { toast } from "sonner";
import { api } from "../services/api";

/**
 * Downloads a meeting protocol DOCX.
 * In desktop mode, saves directly to ~/Downloads and reveals in Finder,
 * while providing an "Открыть файл" toast action button.
 * If direct desktop save fails, falls back gracefully to browser blob download.
 */
export async function downloadMeetingProtocol(
  meetingId: string,
  lang: "ru" | "kz" = "ru",
  title?: string
): Promise<{ success: boolean; filename?: string; path?: string }> {
  // 1. Primary: Native direct save to ~/Downloads via local backend
  try {
    const res = await api.saveExportDocx(meetingId, lang, { openFolder: true });
    if (res.success) {
      toast.success("Протокол сохранен в Загрузки", {
        description: res.filename,
        action: {
          label: "Открыть файл",
          onClick: () => {
            api.openSystemFile(res.path).catch((err) => {
              console.error("Failed to open file", err);
              toast.error("Не удалось открыть файл");
            });
          },
        },
        duration: 6000,
      });
      return res;
    }
  } catch (directErr: any) {
    console.warn("Direct save to downloads failed, attempting blob fallback:", directErr);
  }

  // 2. Fallback: Fetch blob from GET endpoint and download via file-saver
  try {
    const url = api.getExportDocxUrl(meetingId, lang);
    const resp = await fetch(url);
    if (!resp.ok) {
      const errText = await resp.text().catch(() => resp.statusText);
      throw new Error(`Ошибка сервера (${resp.status}): ${errText}`);
    }

    const blob = await resp.blob();
    const cleanTitle = (title || "Совещание").replace(/[/\\?%*:|"<>]+/g, "-").trim();
    const prefix = lang === "kz" ? "Хаттама" : "Протокол";
    const langTag = lang === "kz" ? "KZ" : "RU";
    const filename = `${prefix} - ${cleanTitle} (${langTag}).docx`;

    saveAs(blob, filename);

    // Also trigger programmatic anchor click as additional safety for webviews
    try {
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objectUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(objectUrl), 2000);
    } catch {
      // Ignored if DOM anchor click fails
    }

    toast.success("Протокол скачан", {
      description: filename,
      duration: 4000,
    });
    return { success: true, filename };
  } catch (err: any) {
    console.error("Download meeting protocol error:", err);
    toast.error("Ошибка скачивания протокола", {
      description: err.message || String(err),
      duration: 5000,
    });
    throw err;
  }
}

/**
 * Downloads a meeting protocol in PDF format.
 * In desktop mode, saves directly to ~/Downloads and reveals in Finder.
 * Falls back gracefully to browser blob download.
 */
export async function downloadMeetingProtocolPdf(
  meetingId: string,
  lang: "ru" | "kz" = "ru",
  title?: string
): Promise<{ success: boolean; filename?: string; path?: string }> {
  // 1. Primary: Native direct save to ~/Downloads via local backend
  try {
    const res = await api.saveExportPdf(meetingId, lang, { openFolder: true });
    if (res.success) {
      toast.success("PDF протокол сохранен в Загрузки", {
        description: res.filename,
        action: {
          label: "Открыть файл",
          onClick: () => {
            api.openSystemFile(res.path).catch((err) => {
              console.error("Failed to open file", err);
              toast.error("Не удалось открыть файл");
            });
          },
        },
        duration: 6000,
      });
      return res;
    }
  } catch (directErr: any) {
    console.warn("Direct save to downloads failed, attempting blob fallback:", directErr);
  }

  // 2. Fallback: Fetch blob from GET endpoint and download via file-saver
  try {
    const url = api.getExportPdfUrl(meetingId, lang);
    const resp = await fetch(url);
    if (!resp.ok) {
      const errText = await resp.text().catch(() => resp.statusText);
      throw new Error(`Ошибка сервера (${resp.status}): ${errText}`);
    }

    const blob = await resp.blob();
    const cleanTitle = (title || "Совещание").replace(/[/\\?%*:|"<>]+/g, "-").trim();
    const prefix = lang === "kz" ? "Хаттама" : "Протокол";
    const langTag = lang === "kz" ? "KZ" : "RU";
    const filename = `${prefix} - ${cleanTitle} (${langTag}).pdf`;

    saveAs(blob, filename);

    try {
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objectUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(objectUrl), 2000);
    } catch {
      // Ignored
    }

    toast.success("PDF протокол скачан", {
      description: filename,
      duration: 4000,
    });
    return { success: true, filename };
  } catch (err: any) {
    console.error("Download meeting protocol PDF error:", err);
    toast.error("Ошибка скачивания PDF протокола", {
      description: err.message || String(err),
      duration: 5000,
    });
    throw err;
  }
}

/**
 * Downloads an arbitrary file (templates, sample docx, etc.) from a URL.
 * Attempts native direct save to ~/Downloads first, falling back to browser blob download.
 */
export async function downloadFileFromUrl(url: string, filename: string): Promise<void> {
  // 1. Try local backend saving
  try {
    const res = await api.saveUrlToDownloads(url, filename, true);
    if (res.success) {
      toast.success("Файл сохранен в Загрузки", {
        description: res.filename,
        action: {
          label: "Открыть файл",
          onClick: () => {
            api.openSystemFile(res.path).catch((err) => {
              console.error("Failed to open file", err);
              toast.error("Не удалось открыть файл");
            });
          },
        },
        duration: 5000,
      });
      return;
    }
  } catch (e) {
    console.warn("Direct saveUrlToDownloads failed, attempting blob fallback:", e);
  }

  // 2. Blob fallback
  try {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Ошибка загрузки: ${resp.statusText}`);
    const blob = await resp.blob();
    saveAs(blob, filename);

    toast.success("Файл скачан", {
      description: filename,
      duration: 4000,
    });
  } catch (err: any) {
    console.error("downloadFileFromUrl error:", err);
    toast.error("Ошибка скачивания файла", {
      description: err.message || String(err),
      duration: 5000,
    });
  }
}
