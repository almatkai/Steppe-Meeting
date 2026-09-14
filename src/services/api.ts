import type { Meeting, Participant, SystemConfig, SystemStatus, ChatSession, ChatMessage, Citation, ProtocolTemplate, ProtocolTemplateSlot, TemplateTestResult } from "../types";

const API_BASE = "http://127.0.0.1:8008/api/v1";

export const api = {
  // Meetings
  async listMeetings(query?: string): Promise<Meeting[]> {
    const url = query ? `${API_BASE}/meetings?q=${encodeURIComponent(query)}` : `${API_BASE}/meetings`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to list meetings: ${res.statusText}`);
    return res.json();
  },

  async getMeeting(id: string): Promise<Meeting> {
    const res = await fetch(`${API_BASE}/meetings/${id}`);
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
    const res = await fetch(`${API_BASE}/meetings/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    if (!res.ok) throw new Error(`Failed to create meeting: ${res.statusText}`);
    return res.json();
  },

  async uploadAudio(meetingId: string, file: File): Promise<any> {
    const form = new FormData();
    form.append("file", file);
    const res = await fetch(`${API_BASE}/meetings/${meetingId}/upload-audio`, {
      method: "POST",
      body: form,
    });
    if (!res.ok) throw new Error(`Failed to upload audio: ${res.statusText}`);
    return res.json();
  },

  async transcribe(meetingId: string): Promise<any> {
    const res = await fetch(`${API_BASE}/meetings/${meetingId}/transcribe`, {
      method: "POST",
    });
    if (!res.ok) throw new Error(`Failed to start transcription: ${res.statusText}`);
    return res.json();
  },

  async generate(meetingId: string): Promise<any> {
    const res = await fetch(`${API_BASE}/meetings/${meetingId}/generate`, {
      method: "POST",
    });
    if (!res.ok) throw new Error(`Failed to start generation: ${res.statusText}`);
    return res.json();
  },

  async updateMeeting(meetingId: string, data: Partial<Meeting> & { template_id?: string }): Promise<any> {
    const res = await fetch(`${API_BASE}/meetings/${meetingId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    if (!res.ok) throw new Error(`Failed to update meeting: ${res.statusText}`);
    return res.json();
  },

  async deleteMeeting(meetingId: string): Promise<any> {
    const res = await fetch(`${API_BASE}/meetings/${meetingId}`, {
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
      const res = await fetch(`${API_BASE}/chat`, {
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
    const res = await fetch(`${API_BASE}/edit`, {
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
    const res = await fetch(`${API_BASE}/system/status`);
    if (!res.ok) throw new Error(`Failed to get system status: ${res.statusText}`);
    return res.json();
  },

  async listModels(): Promise<string[]> {
    const res = await fetch(`${API_BASE}/system/models`);
    if (!res.ok) return ["qwen2.5:latest", "llama3.2:latest"];
    return res.json();
  },

  async getConfig(): Promise<SystemConfig> {
    const res = await fetch(`${API_BASE}/system/config`);
    if (!res.ok) throw new Error(`Failed to get config: ${res.statusText}`);
    return res.json();
  },

  async saveConfig(config: Partial<SystemConfig>): Promise<any> {
    const res = await fetch(`${API_BASE}/system/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(config),
    });
    if (!res.ok) throw new Error(`Failed to save config: ${res.statusText}`);
    return res.json();
  },

  // Whisper STT Management
  async getWhisperStatus(): Promise<any> {
    const res = await fetch(`${API_BASE}/system/whisper/status`);
    if (!res.ok) throw new Error(`Failed to get Whisper status: ${res.statusText}`);
    return res.json();
  },

  async installWhisperEnv(): Promise<{ status: string; message: string }> {
    const res = await fetch(`${API_BASE}/system/whisper/install-env`, {
      method: "POST",
    });
    if (!res.ok) throw new Error(`Failed to start Whisper env install: ${res.statusText}`);
    return res.json();
  },

  async downloadWhisperModel(model: string): Promise<{ status: string; message: string }> {
    const res = await fetch(`${API_BASE}/system/whisper/download-model`, {
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
    const res = await fetch(`${API_BASE}/system/whisper/delete-model`, {
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
    const res = await fetch(`${API_BASE}/meetings/${meetingId}/export/docx/save`, {
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
    const res = await fetch(`${API_BASE}/meetings/${meetingId}/export/pdf/save`, {
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
    const res = await fetch(`${API_BASE}/system/open-file`, {
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
    const res = await fetch(`${API_BASE}/system/reveal-file`, {
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
    const res = await fetch(`${API_BASE}/system/save-url-to-downloads`, {
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
    const res = await fetch(`${API_BASE}/templates`);
    if (!res.ok) throw new Error(`Failed to list templates: ${res.statusText}`);
    return res.json();
  },

  async getTemplate(id: string): Promise<ProtocolTemplate> {
    const res = await fetch(`${API_BASE}/templates/${id}`);
    if (!res.ok) throw new Error(`Failed to get template: ${res.statusText}`);
    return res.json();
  },

  async previewTemplateSlots(file: File): Promise<{ slots: ProtocolTemplateSlot[]; render_ready: boolean; stats: any; warnings: string[] }> {
    const formData = new FormData();
    formData.append("file", file);
    const res = await fetch(`${API_BASE}/templates/parse-preview`, {
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
    const res = await fetch(`${API_BASE}/templates/upload`, {
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
    const res = await fetch(`${API_BASE}/templates/${id}`, {
      method: "DELETE",
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: res.statusText }));
      throw new Error(err.detail || "Ошибка удаления шаблона");
    }
    return res.json();
  },

  async testTemplate(id: string, data?: { transcript?: string; detail_level?: string }): Promise<TemplateTestResult> {
    const res = await fetch(`${API_BASE}/templates/${id}/test`, {
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
    const res = await fetch(`${API_BASE}/chat/sessions`);
    if (!res.ok) throw new Error(`Failed to list chat sessions: ${res.statusText}`);
    return res.json();
  },

  async createChatSession(title?: string): Promise<ChatSession> {
    const res = await fetch(`${API_BASE}/chat/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: title || "Новый диалог" }),
    });
    if (!res.ok) throw new Error(`Failed to create chat session: ${res.statusText}`);
    return res.json();
  },

  async getSessionMessages(sessionId: string): Promise<ChatMessage[]> {
    const res = await fetch(`${API_BASE}/chat/sessions/${sessionId}/messages`);
    if (!res.ok) throw new Error(`Failed to get session messages: ${res.statusText}`);
    return res.json();
  },

  async deleteChatSession(sessionId: string): Promise<any> {
    const res = await fetch(`${API_BASE}/chat/sessions/${sessionId}`, {
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
      const res = await fetch(`${API_BASE}/chat/sessions/${sessionId}/messages`, {
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
    const res = await fetch(`${API_BASE}/search/reindex`, { method: "POST" });
    if (!res.ok) throw new Error(`Reindex error: ${res.statusText}`);
    return res.json();
  },

  async getSearchStats(): Promise<{ total_chunks: number; indexed_meetings: number }> {
    const res = await fetch(`${API_BASE}/search/stats`);
    if (!res.ok) throw new Error(`Search stats error: ${res.statusText}`);
    return res.json();
  },
};
