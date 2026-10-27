import type { ReleaseUpdate, UpdateChannel, CliProviderId, CliCheckResult, CliModelsResult, CliTestResult } from "../types";
import { invoke } from "@tauri-apps/api/core";
import type { CaptionChunk, CaptionResult, StreamingTranscript } from "../utils/liveCaptions";
import type { Meeting, Participant, SystemConfig, SystemStatus, WhisperStatus, ChatSession, ChatMessage, Citation, ProtocolTemplate, ProtocolTemplateSlot, TemplateTestResult } from "../types";

const API_BASE = "http://127.0.0.1:8008/api/v1";

// Each webview shares one startup attempt across its concurrent API requests.
// A failed request invalidates it so the next user retry can restart the server.
let backendReady: Promise<void> | undefined;
async function backendFetch(url: string, options: RequestInit = {}): Promise<Response> {
  const native = typeof window !== "undefined" && Boolean((window as any).__TAURI_INTERNALS__);
  if (native) {
    backendReady ??= invoke<void>("ensure_backend").catch((error) => {
      backendReady = undefined;
      throw new Error(String(error));
    });
    await backendReady;
  }
  const bounded = url.includes("/system/") || (url.includes("/templates") && (!options.method || options.method === "GET"));
  try {
    return await fetch(url, {
      ...options,
      ...(bounded && !options.signal ? { signal: AbortSignal.timeout(15000) } : {}),
    });
  } catch (error) {
    backendReady = undefined;
    if (error instanceof Error && error.name === "TimeoutError") {
      if (url.includes('/system/cli/')) throw error;
      throw new Error("Локальный сервер не ответил вовремя. Повторите подключение.");
    }
    if (error instanceof TypeError) {
      throw new Error("Локальный сервер недоступен (127.0.0.1:8008). Повторите подключение; для браузерного режима запустите ./backend/run_backend.sh.");
    }
    throw error;
  }
}

async function recordingResponse(res: Response): Promise<any> {
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    const detail = body?.detail;
    if (typeof detail === "string") throw new Error(detail);
    if (Array.isArray(detail)) {
      throw new Error("Приложение отправило неполные или некорректные данные. Обновите приложение и повторите действие.");
    }
    throw new Error(`Ошибка сервера (${res.status})`);
  }
  return res.json();
}

export const api = {
  // Meetings
  async listMeetings(query?: string): Promise<Meeting[]> {
    const url = query ? `${API_BASE}/meetings?q=${encodeURIComponent(query)}` : `${API_BASE}/meetings`;
    const res = await backendFetch(url);
    if (!res.ok) throw new Error(`Failed to list meetings: ${res.statusText}`);
    return res.json();
  },

  async getMeeting(id: string): Promise<Meeting> {
    const res = await backendFetch(`${API_BASE}/meetings/${id}`);
    if (!res.ok) throw new Error(`Failed to get meeting: ${res.statusText}`);
    return res.json();
  },

  async createMeeting(data: {
    title: string;
    source_language?: string;
    agenda?: string;
    participants?: Participant[];
    transcript_text?: string;
    template_id?: string;
  }): Promise<{ id: string; status: string; created_at: string }> {
    const res = await backendFetch(`${API_BASE}/meetings/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) throw new Error(`Failed to create meeting: ${res.statusText}`);
    return res.json();
  },

  async uploadAudio(meetingId: string, file: File): Promise<any> {
    const form = new FormData();
    form.append("file", file);
    const res = await backendFetch(`${API_BASE}/meetings/${meetingId}/upload-audio`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(60000),
    });
    return recordingResponse(res);
  },

  async stopGeneration(meetingId: string): Promise<{ meeting_id: string; status: Meeting["status"] }> {
    return recordingResponse(await backendFetch(`${API_BASE}/meetings/${meetingId}/stop-generation`, {
      method: "POST", signal: AbortSignal.timeout(20000),
    }));
  },

  async processRecording(meetingId: string, transcript: StreamingTranscript): Promise<{ status: string }> {
    const res = await backendFetch(`${API_BASE}/meetings/${meetingId}/process-recording`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(transcript),
      signal: AbortSignal.timeout(30000),
    });
    return recordingResponse(res);
  },

  async startRecordingSession(meetingId: string): Promise<{ session_id: string; model: string; mode: string }> {
    return recordingResponse(await backendFetch(`${API_BASE}/meetings/${meetingId}/recording-session`, {
      method: "POST", signal: AbortSignal.timeout(30000),
    }));
  },

  async cancelRecording(meetingId: string, sessionId: string): Promise<unknown> {
    return recordingResponse(await backendFetch(`${API_BASE}/meetings/${meetingId}/cancel-recording`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: sessionId }), signal: AbortSignal.timeout(30000),
    }));
  },

  async transcribeCaption(audio: Blob, signal: AbortSignal, chunk: CaptionChunk, sessionId: string): Promise<CaptionResult> {
    const form = new FormData();
    form.append("file", audio, "caption.wav");
    form.append("session_id", sessionId);
    form.append("index", String(chunk.index));
    form.append("offset_seconds", String(chunk.offset_seconds));
    const res = await backendFetch(`${API_BASE}/captions/transcribe`, {
      method: "POST", body: form,
      signal: AbortSignal.any([signal, AbortSignal.timeout(120000)]),
    });
    const result = await recordingResponse(res);
    return result;
  },

  async transcribe(meetingId: string, autoGenerate: boolean = false): Promise<any> {
    const query = autoGenerate ? "?auto_generate=true" : "";
    const res = await backendFetch(`${API_BASE}/meetings/${meetingId}/transcribe${query}`, {
      method: "POST",
    });
    if (!res.ok) throw new Error(`Failed to start transcription: ${res.statusText}`);
    return res.json();
  },

  async generate(meetingId: string): Promise<any> {
    const res = await backendFetch(`${API_BASE}/meetings/${meetingId}/generate`, {
      method: "POST",
    });
    if (!res.ok) throw new Error(`Failed to start generation: ${res.statusText}`);
    return res.json();
  },

  async updateMeeting(meetingId: string, data: Partial<Meeting> & { template_id?: string }): Promise<any> {
    const res = await backendFetch(`${API_BASE}/meetings/${meetingId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    if (!res.ok) throw new Error(`Failed to update meeting: ${res.statusText}`);
    return res.json();
  },

  async deleteMeeting(meetingId: string): Promise<any> {
    const res = await backendFetch(`${API_BASE}/meetings/${meetingId}`, {
      method: "DELETE",
    });
    if (!res.ok) throw new Error(`Failed to delete meeting: ${res.statusText}`);
    return res.json();
  },

  // AI Chat & Edit
  async chatStream(
    meetingId: string | null,
    messages: { role: string; content: string }[],
    context: any,
    onChunk: (chunk: string) => void,
    onError: (err: string) => void
  ) {
    try {
      const res = await backendFetch(`${API_BASE}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ meeting_id: meetingId, messages, context }),
      });

      if (!res.ok) {
        throw new Error(`Chat error: ${res.statusText}`);
      }

      const reader = res.body?.getReader();
      if (!reader) throw new Error("No response body");

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith("data: ")) continue;
          const dataStr = trimmed.slice(6);
          if (dataStr === "[DONE]") return;

          try {
            const parsed = JSON.parse(dataStr);
            if (parsed.error) {
              const errMsg = typeof parsed.error === "object"
                ? (parsed.error.message || JSON.stringify(parsed.error))
                : String(parsed.error);
              onError(errMsg);
              return;
            }
            const content = parsed.choices?.[0]?.delta?.content || "";
            if (content) {
              onChunk(content);
            }
          } catch {
            // If dataStr is not JSON, check if it has content
            if (dataStr && !dataStr.startsWith("{") && !dataStr.startsWith("[")) {
              onChunk(dataStr);
            }
          }
        }
      }
    } catch (e: any) {
      onError(e.message || String(e));
    }
  },

  async editText(selectedText: string, instruction: string, context?: any): Promise<string> {
    const res = await backendFetch(`${API_BASE}/edit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ selected_text: selectedText, instruction, context }),
    });
    if (!res.ok) throw new Error(`Failed to edit text: ${res.statusText}`);
    const data = await res.json();
    return data.edited_text;
  },

  // Diagnostics & Config
  async getSystemStatus(): Promise<SystemStatus> {
    const res = await backendFetch(`${API_BASE}/system/status`);
    if (!res.ok) throw new Error(`Failed to get system status: ${res.statusText}`);
    return res.json();
  },

  async listModels(connection?: { base_url: string; api_key: string }): Promise<string[]> {
    const res = await backendFetch(`${API_BASE}/system/models`, connection ? {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(connection),
    } : undefined);
    if (!res.ok) throw new Error(`Не удалось получить список моделей (HTTP ${res.status})`);
    return res.json();
  },

  async getConfig(): Promise<SystemConfig> {
    const res = await backendFetch(`${API_BASE}/system/config`);
    if (!res.ok) throw new Error(`Failed to get config: ${res.statusText}`);
    return res.json();
  },

  async checkUpdates(query: { current_version: string; channel: UpdateChannel; platform: string; arch: string; force: boolean }): Promise<ReleaseUpdate> {
    const params = new URLSearchParams({ ...query, force: String(query.force) });
    const res = await backendFetch(`${API_BASE}/system/updates?${params}`, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`Не удалось проверить обновления (HTTP ${res.status})`);
    return res.json();
  },

  async saveUpdateChannel(channel: UpdateChannel): Promise<{ channel: UpdateChannel }> {
    const res = await backendFetch(`${API_BASE}/system/updates/channel`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ channel }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(typeof body.detail === 'string' ? body.detail : 'Не удалось сохранить канал обновлений');
    }
    const body = await res.json();
    if (body?.channel !== channel) throw new Error('Локальный сервер не подтвердил канал обновлений');
    return body;
  },

  async checkCli(provider: CliProviderId, path?: string): Promise<CliCheckResult> {
    return cliAction("check", { provider, path });
  },
  async cliModels(provider: CliProviderId, path?: string): Promise<CliModelsResult> {
    return cliAction("models", { provider, path });
  },
  async testCli(provider: CliProviderId, path?: string, model?: string): Promise<CliTestResult> {
    return cliAction("test", { provider, path, model });
  },

  async saveConfig(config: Partial<SystemConfig>): Promise<any> {
    const res = await backendFetch(`${API_BASE}/system/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(config),
    });
    if (!res.ok) {
      const error = await res.json().catch(() => ({}));
      throw new Error(typeof error.detail === 'string' ? error.detail : `Не удалось сохранить настройки (HTTP ${res.status})`);
    }
    const body = await res.json();
    if (body?.success !== true) throw new Error('Локальный сервер не подтвердил сохранение настроек');
    return body;
  },

  // Whisper STT Management
  async getWhisperStatus(): Promise<WhisperStatus> {
    const res = await backendFetch(`${API_BASE}/system/whisper/status`);
    if (!res.ok) throw new Error(`Failed to get Whisper status: ${res.statusText}`);
    return res.json();
  },

  async installWhisperEnv(model: string): Promise<{ status: string; message: string }> {
    const res = await backendFetch(`${API_BASE}/system/whisper/install-env`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: res.statusText }));
      throw new Error(err.detail || "Ошибка установки среды");
    }
    return res.json();
  },

  async downloadWhisperModel(model: string): Promise<{ status: string; message: string }> {
    const res = await backendFetch(`${API_BASE}/system/whisper/download-model`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: res.statusText }));
      throw new Error(err.detail || "Ошибка скачивания модели");
    }
    return res.json();
  },

  async deleteWhisperModel(model: string): Promise<{ status: string; model: string }> {
    const res = await backendFetch(`${API_BASE}/system/whisper/delete-model`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: res.statusText }));
      throw new Error(err.detail || "Ошибка удаления модели");
    }
    return res.json();
  },

  // DOCX Export URL
  getExportDocxUrl(meetingId: string, lang: "ru" | "kz" = "ru", templateId?: string, mode?: string): string {
    let url = `${API_BASE}/meetings/${meetingId}/export/docx?lang=${lang}`;
    if (templateId) url += `&template_id=${encodeURIComponent(templateId)}`;
    if (mode) url += `&mode=${encodeURIComponent(mode)}`;
    return url;
  },

  async saveExportDocx(
    meetingId: string,
    lang: "ru" | "kz" = "ru",
    options?: { openFolder?: boolean; openFile?: boolean; templateId?: string }
  ): Promise<{ success: boolean; filename: string; path: string }> {
    const res = await backendFetch(`${API_BASE}/meetings/${meetingId}/export/docx/save`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        lang,
        template_id: options?.templateId,
        open_folder: options?.openFolder ?? true,
        open_file: options?.openFile ?? false,
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: res.statusText }));
      throw new Error(err.detail || "Не удалось экспортировать протокол");
    }
    return res.json();
  },

  // PDF Export URL
  getExportPdfUrl(meetingId: string, lang: "ru" | "kz" = "ru"): string {
    return `${API_BASE}/meetings/${meetingId}/export/pdf?lang=${lang}`;
  },

  async saveExportPdf(
    meetingId: string,
    lang: "ru" | "kz" = "ru",
    options?: { openFolder?: boolean; openFile?: boolean }
  ): Promise<{ success: boolean; filename: string; path: string }> {
    const res = await backendFetch(`${API_BASE}/meetings/${meetingId}/export/pdf/save`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        lang,
        open_folder: options?.openFolder ?? true,
        open_file: options?.openFile ?? false,
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: res.statusText }));
      throw new Error(err.detail || "Не удалось экспортировать протокол в PDF");
    }
    return res.json();
  },

  async openSystemFile(path: string): Promise<any> {
    const res = await backendFetch(`${API_BASE}/system/open-file`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: res.statusText }));
      throw new Error(err.detail || "Не удалось открыть файл");
    }
    return res.json();
  },

  async revealSystemFile(path: string): Promise<any> {
    const res = await backendFetch(`${API_BASE}/system/reveal-file`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: res.statusText }));
      throw new Error(err.detail || "Не удалось показать файл");
    }
    return res.json();
  },

  async saveUrlToDownloads(url: string, filename: string, openFolder = true): Promise<{ success: boolean; filename: string; path: string }> {
    const res = await backendFetch(`${API_BASE}/system/save-url-to-downloads`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, filename, open_folder: openFolder }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: res.statusText }));
      throw new Error(err.detail || "Не удалось сохранить файл");
    }
    return res.json();
  },

  // Protocol Templates Management
  async listTemplates(): Promise<ProtocolTemplate[]> {
    const res = await backendFetch(`${API_BASE}/templates`);
    if (!res.ok) throw new Error(`Failed to list templates: ${res.statusText}`);
    return res.json();
  },

  async getTemplate(id: string): Promise<ProtocolTemplate> {
    const res = await backendFetch(`${API_BASE}/templates/${id}`);
    if (!res.ok) throw new Error(`Failed to get template: ${res.statusText}`);
    return res.json();
  },

  async previewTemplateSlots(file: File): Promise<{ slots: ProtocolTemplateSlot[]; render_ready: boolean; stats: any; warnings: string[] }> {
    const formData = new FormData();
    formData.append("file", file);
    const res = await backendFetch(`${API_BASE}/templates/parse-preview`, {
      method: "POST",
      body: formData,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: res.statusText }));
      throw new Error(err.detail || "Ошибка проверки шаблона");
    }
    return res.json();
  },

  async uploadTemplate(formData: FormData): Promise<{ id: string; name: string; slots_count: number; render_ready: boolean; created_at: string }> {
    const res = await backendFetch(`${API_BASE}/templates/upload`, {
      method: "POST",
      body: formData,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: res.statusText }));
      throw new Error(err.detail || "Ошибка загрузки шаблона");
    }
    return res.json();
  },

  async deleteTemplate(id: string): Promise<{ success: boolean; detached_meetings?: number }> {
    const res = await backendFetch(`${API_BASE}/templates/${id}`, {
      method: "DELETE",
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: res.statusText }));
      throw new Error(err.detail || "Ошибка удаления шаблона");
    }
    return res.json();
  },

  async testTemplate(id: string, data?: { transcript?: string; detail_level?: string }): Promise<TemplateTestResult> {
    const res = await backendFetch(`${API_BASE}/templates/${id}/test`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data || {}),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: res.statusText }));
      throw new Error(err.detail || "Ошибка тестирования шаблона");
    }
    return res.json();
  },

  getTemplateDownloadUrl(id: string, variant: "working" | "source" = "working"): string {
    return `${API_BASE}/templates/${id}/download?variant=${variant}`;
  },

  getTestDocxDownloadUrl(id: string): string {
    return `${API_BASE}/templates/${id}/test-download`;
  },

  getTestPdfDownloadUrl(id: string): string {
    return `${API_BASE}/templates/${id}/test-download-pdf`;
  },

  getSampleTemplateDownloadUrl(): string {
    return `${API_BASE}/templates/sample/download`;
  },

  // Multi-Turn RAG Chat Sessions & Search
  async listChatSessions(): Promise<ChatSession[]> {
    const res = await backendFetch(`${API_BASE}/chat/sessions`);
    if (!res.ok) throw new Error(`Failed to list chat sessions: ${res.statusText}`);
    return res.json();
  },

  async createChatSession(title?: string): Promise<ChatSession> {
    const res = await backendFetch(`${API_BASE}/chat/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: title || "Новый диалог" }),
    });
    if (!res.ok) throw new Error(`Failed to create chat session: ${res.statusText}`);
    return res.json();
  },

  async getSessionMessages(sessionId: string): Promise<ChatMessage[]> {
    const res = await backendFetch(`${API_BASE}/chat/sessions/${sessionId}/messages`);
    if (!res.ok) throw new Error(`Failed to get session messages: ${res.statusText}`);
    return res.json();
  },

  async deleteChatSession(sessionId: string): Promise<any> {
    const res = await backendFetch(`${API_BASE}/chat/sessions/${sessionId}`, {
      method: "DELETE",
    });
    if (!res.ok) throw new Error(`Failed to delete chat session: ${res.statusText}`);
    return res.json();
  },

  async streamSessionMessage(
    sessionId: string,
    content: string,
    callbacks: {
      onCitations?: (citations: Citation[]) => void;
      onDelta?: (delta: string) => void;
      onDone?: (data: { message_id: string; full_text: string }) => void;
      onError?: (error: string) => void;
    },
    filterMeetingId?: string,
    signal?: AbortSignal
  ): Promise<void> {
    try {
      const res = await backendFetch(`${API_BASE}/chat/sessions/${sessionId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content, filter_meeting_id: filterMeetingId }),
        signal,
      });

      if (!res.ok) {
        throw new Error(`Chat stream error (${res.status}): ${res.statusText}`);
      }

      const reader = res.body?.getReader();
      if (!reader) throw new Error("No readable stream received from server");

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n\n");
        buffer = lines.pop() || "";

        for (const block of lines) {
          const trimBlock = block.trim();
          if (!trimBlock) continue;

          let eventName = "message";
          let dataStr = "";

          const blockLines = trimBlock.split("\n");
          for (const l of blockLines) {
            if (l.startsWith("event: ")) {
              eventName = l.substring(7).trim();
            } else if (l.startsWith("data: ")) {
              dataStr = l.substring(6).trim();
            }
          }

          if (dataStr) {
            try {
              const parsed = JSON.parse(dataStr);
              if (eventName === "citations" && callbacks.onCitations) {
                callbacks.onCitations(parsed.citations || []);
              } else if (eventName === "delta" && callbacks.onDelta) {
                callbacks.onDelta(parsed.delta || "");
              } else if (eventName === "done" && callbacks.onDone) {
                callbacks.onDone(parsed);
              } else if (eventName === "error" && callbacks.onError) {
                callbacks.onError(parsed.error || "Unknown stream error");
              }
            } catch (e) {
              console.debug("Error parsing SSE data chunk", e);
            }
          }
        }
      }
    } catch (err: any) {
      if (err.name === "AbortError") {
        console.log("Chat stream aborted by user");
        return;
      }
      callbacks.onError?.(err.message || String(err));
    }
  },

  async reindexAll(): Promise<{ status: string; meetings_processed: number; meetings_indexed: number; total_chunks: number }> {
    const res = await backendFetch(`${API_BASE}/search/reindex`, { method: "POST" });
    if (!res.ok) throw new Error(`Reindex error: ${res.statusText}`);
    return res.json();
  },

  async getSearchStats(): Promise<{ total_chunks: number; indexed_meetings: number }> {
    const res = await backendFetch(`${API_BASE}/search/stats`);
    if (!res.ok) throw new Error(`Search stats error: ${res.statusText}`);
    return res.json();
  },
};

async function cliAction(action: string, values: object) {
  // Include the backend's model budget and session cleanup in the deadline.
  const timeoutMs = action === 'test' ? 75000 : 20000;
  try {
    const res = await backendFetch(`${API_BASE}/system/cli/${action}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(values),
      signal: AbortSignal.timeout(timeoutMs),
    });
    let body;
    try { body = await res.json(); }
    catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError') throw error;
      throw new Error(res.ok ? 'CLI вернул некорректный ответ. Повторите действие.' : `Не удалось выполнить действие CLI (HTTP ${res.status}). Повторите действие.`);
    }
    if (!res.ok) throw new Error(typeof body?.detail === 'string' ? body.detail : `Не удалось выполнить действие CLI (HTTP ${res.status})`);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('CLI вернул некорректный ответ. Повторите действие.');
    return body;
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') throw new Error(`CLI не ответил за ${timeoutMs / 1000} с. Повторите действие.`);
    throw error;
  }
}
