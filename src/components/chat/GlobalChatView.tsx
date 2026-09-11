import React, { useState, useEffect, useRef } from "react";
import {
  MessageSquare,
  Plus,
  Trash2,
  Send,
  Square,
  Bot,
  User,
  Copy,
  Check,
  ExternalLink,
  Sparkles,
  Database,
  RefreshCw,
  Clock,
  FileText,
  ChevronRight,
  Search,
} from "lucide-react";
import { api } from "../../services/api";
import { useMeetingStore } from "../../store/useMeetingStore";
import { SteppeIcon, SteppeLogo } from "../ui/SteppeIcon";
import type { ChatSession, ChatMessage, Citation } from "../../types";

export const GlobalChatView: React.FC = () => {
  const { selectMeeting } = useMeetingStore();

  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isLoadingSessions, setIsLoadingSessions] = useState(true);
  const [isLoadingMessages, setIsLoadingMessages] = useState(false);

  const [inputPrompt, setInputPrompt] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingCitations, setStreamingCitations] = useState<Citation[]>([]);
  const [streamingDelta, setStreamingDelta] = useState("");

  const [searchStats, setSearchStats] = useState<{ total_chunks: number; indexed_meetings: number } | null>(null);
  const [isReindexing, setIsReindexing] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const abortControllerRef = useRef<AbortController | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Load chat sessions on mount
  useEffect(() => {
    loadSessions();
    loadStats();
  }, []);

  // When active session changes, load its messages
  useEffect(() => {
    if (activeSessionId) {
      loadMessages(activeSessionId);
    } else {
      setMessages([]);
    }
  }, [activeSessionId]);

  // Scroll to bottom when messages update or streaming
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamingDelta, streamingCitations]);

  const loadSessions = async () => {
    try {
      setIsLoadingSessions(true);
      const data = await api.listChatSessions();
      setSessions(data);
      if (data.length > 0 && !activeSessionId) {
        setActiveSessionId(data[0].id);
      }
    } catch (err) {
      console.error("Failed to load chat sessions:", err);
    } finally {
      setIsLoadingSessions(false);
    }
  };

  const loadStats = async () => {
    try {
      const stats = await api.getSearchStats();
      setSearchStats(stats);
    } catch (err) {
      console.debug("Failed to load search stats", err);
    }
  };

  const loadMessages = async (sessionId: string) => {
    try {
      setIsLoadingMessages(true);
      const data = await api.getSessionMessages(sessionId);
      setMessages(data);
    } catch (err) {
      console.error("Failed to load session messages:", err);
    } finally {
      setIsLoadingMessages(false);
    }
  };

  const handleCreateSession = async () => {
    try {
      const newSession = await api.createChatSession("Новый диалог");
      setSessions((prev) => [newSession, ...prev]);
      setActiveSessionId(newSession.id);
      setMessages([]);
      textareaRef.current?.focus();
    } catch (err) {
      console.error("Failed to create session:", err);
    }
  };

  const handleDeleteSession = async (e: React.MouseEvent, sessionId: string) => {
    e.stopPropagation();
    try {
      await api.deleteChatSession(sessionId);
      const remaining = sessions.filter((s) => s.id !== sessionId);
      setSessions(remaining);
      if (activeSessionId === sessionId) {
        setActiveSessionId(remaining.length > 0 ? remaining[0].id : null);
      }
    } catch (err) {
      console.error("Failed to delete session:", err);
    }
  };

  const handleReindex = async () => {
    try {
      setIsReindexing(true);
      await api.reindexAll();
      await loadStats();
    } catch (err) {
      console.error("Failed to reindex meetings:", err);
    } finally {
      setIsReindexing(false);
    }
  };

  const handleSendMessage = async (promptToSend?: string) => {
    const text = (promptToSend || inputPrompt).trim();
    if (!text || isStreaming) return;

    let targetSessionId = activeSessionId;
    if (!targetSessionId) {
      try {
        const created = await api.createChatSession(text.slice(0, 30));
        targetSessionId = created.id;
        setSessions((prev) => [created, ...prev]);
        setActiveSessionId(created.id);
      } catch (err) {
        console.error("Failed to create initial session:", err);
        return;
      }
    }

    const optimisticUserMsg: ChatMessage = {
      id: `temp-${Date.now()}`,
      session_id: targetSessionId,
      role: "user",
      content: text,
      created_at: new Date().toISOString(),
    };

    setMessages((prev) => [...prev, optimisticUserMsg]);
    setInputPrompt("");
    setIsStreaming(true);
    setStreamingCitations([]);
    setStreamingDelta("");

    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    let accumulatedText = "";

    await api.streamSessionMessage(
      targetSessionId,
      text,
      {
        onCitations: (citations) => {
          setStreamingCitations(citations);
        },
        onDelta: (delta) => {
          accumulatedText += delta;
          setStreamingDelta((prev) => prev + delta);
        },
        onDone: (data) => {
          const assistantMsg: ChatMessage = {
            id: data.message_id || `asst-${Date.now()}`,
            session_id: targetSessionId!,
            role: "assistant",
            content: accumulatedText || data.full_text,
            citations: streamingCitations,
            created_at: new Date().toISOString(),
          };
          setMessages((prev) => [...prev, assistantMsg]);
          setIsStreaming(false);
          setStreamingCitations([]);
          setStreamingDelta("");
          loadSessions(); // refresh session titles and order
        },
        onError: (err) => {
          console.error("Stream error:", err);
          const errorMsg: ChatMessage = {
            id: `err-${Date.now()}`,
            session_id: targetSessionId!,
            role: "assistant",
            content: `⚠️ Произошла ошибка при генерации ответа: ${err}`,
            created_at: new Date().toISOString(),
          };
          setMessages((prev) => [...prev, errorMsg]);
          setIsStreaming(false);
          setStreamingDelta("");
        },
      },
      undefined,
      abortController.signal
    );
  };

  const handleStopStream = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
      setIsStreaming(false);
    }
  };

  const copyToClipboard = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const promptSuggestions = [
    "Какие ключевые решения были приняты на последних совещаниях?",
    "Какие поручения и задачи назначены сотрудникам?",
    "Найди обсуждения по срокам и утверждению планов",
    "Сделай сводку по открытым вопросам из протоколов",
  ];

  return (
    <div className="flex h-full w-full overflow-hidden bg-slate-950 select-none">
      {/* ------------------------------------------------------------- */}
      {/* Left Pane: Sessions & Knowledge Base Stats */}
      {/* ------------------------------------------------------------- */}
      <aside className="w-80 border-r border-slate-800/80 bg-slate-900/60 backdrop-blur-xl flex flex-col justify-between shrink-0">
        <div className="flex flex-col h-full overflow-hidden">
          {/* Header & New Chat Button */}
          <div className="p-4 border-b border-slate-800/80 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="w-7 h-7 rounded-lg bg-indigo-600/20 border border-indigo-500/30 flex items-center justify-center text-indigo-400">
                  <SteppeIcon className="w-4 h-4" />
                </div>
                <div>
                  <h2 className="text-sm font-semibold text-white tracking-tight">AI Ассистент</h2>
                  <p className="text-[11px] text-slate-400">Локальный RAG по всем встречам</p>
                </div>
              </div>
            </div>

            <button
              type="button"
              onClick={handleCreateSession}
              className="w-full flex items-center justify-center gap-2 py-2 px-3.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold shadow-md shadow-indigo-600/25 transition-all active:scale-98 cursor-pointer"
            >
              <Plus className="w-4 h-4" />
              <span>Новый диалог</span>
            </button>
          </div>

          {/* Session List */}
          <div className="flex-1 overflow-y-auto p-2 space-y-1">
            {isLoadingSessions ? (
              <div className="p-4 text-center text-xs text-slate-500">Загрузка диалогов...</div>
            ) : sessions.length === 0 ? (
              <div className="p-6 text-center text-slate-500 text-xs">
                <MessageSquare className="w-8 h-8 mx-auto mb-2 opacity-40" />
                <p>Нет активных диалогов</p>
                <p className="text-[11px] text-slate-600 mt-1">Нажмите «Новый диалог», чтобы начать</p>
              </div>
            ) : (
              sessions.map((s) => {
                const isActive = s.id === activeSessionId;
                return (
                  <div
                    key={s.id}
                    onClick={() => setActiveSessionId(s.id)}
                    className={`group relative flex items-center justify-between p-2.5 rounded-xl cursor-pointer transition-all ${
                      isActive
                        ? "bg-slate-800 border border-slate-700/80 text-white shadow-sm"
                        : "text-slate-400 hover:bg-slate-800/40 hover:text-slate-200 border border-transparent"
                    }`}
                  >
                    <div className="flex items-center gap-2.5 min-w-0 flex-1 pr-2">
                      <MessageSquare className={`w-3.5 h-3.5 shrink-0 ${isActive ? "text-indigo-400" : "text-slate-500"}`} />
                      <div className="min-w-0 flex-1">
                        <p className="text-xs font-medium truncate">{s.title || "Новый диалог"}</p>
                        {s.last_message && (
                          <p className="text-[10px] text-slate-500 truncate mt-0.5">{s.last_message}</p>
                        )}
                      </div>
                    </div>

                    <button
                      type="button"
                      onClick={(e) => handleDeleteSession(e, s.id)}
                      className="opacity-0 group-hover:opacity-100 p-1.5 rounded-md hover:bg-rose-500/10 text-slate-500 hover:text-rose-400 transition-all cursor-pointer"
                      title="Удалить диалог"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                );
              })
            )}
          </div>

          {/* Vector Knowledge Base Widget */}
          <div className="p-3 border-t border-slate-800/80 bg-slate-950/40">
            <div className="p-2.5 rounded-xl bg-slate-900/90 border border-slate-800 flex items-center justify-between">
              <div className="flex items-center gap-2 min-w-0">
                <Database className="w-4 h-4 text-cyan-400 shrink-0" />
                <div className="min-w-0 text-[11px]">
                  <p className="text-slate-200 font-medium truncate">Локальная база знаний</p>
                  <p className="text-slate-500 text-[10px]">
                    {searchStats ? `${searchStats.total_chunks} фрагментов (${searchStats.indexed_meetings} встреч)` : "Инициализация..."}
                  </p>
                </div>
              </div>

              <button
                type="button"
                onClick={handleReindex}
                disabled={isReindexing}
                className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors cursor-pointer disabled:opacity-50"
                title="Переиндексировать все совещания"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${isReindexing ? "animate-spin text-indigo-400" : ""}`} />
              </button>
            </div>
          </div>
        </div>
      </aside>

      {/* ------------------------------------------------------------- */}
      {/* Right Pane: Conversation & Chat Input */}
      {/* ------------------------------------------------------------- */}
      <main className="flex-1 flex flex-col h-full overflow-hidden bg-slate-950">
        {/* Chat Area */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6 select-text">
          {isLoadingMessages ? (
            <div className="h-full flex items-center justify-center text-xs text-slate-500">
              Загрузка сообщений...
            </div>
          ) : messages.length === 0 && !isStreaming ? (
            /* Empty State */
            <div className="max-w-xl mx-auto h-full flex flex-col items-center justify-center text-center space-y-6 select-none">
              <SteppeLogo className="w-14 h-14" />
              <div>
                <h3 className="text-xl font-bold text-white tracking-tight">
                  Поиск и аналитика по всем совещаниям
                </h3>
                <p className="text-sm text-slate-400 mt-1 max-w-md mx-auto">
                  Спросите об обсуждавшихся вопросах, принятых решениях или поручениях. Локальный AI найдет точные цитаты из протоколов.
                </p>
              </div>

              {/* Suggestions */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 w-full pt-2">
                {promptSuggestions.map((prompt, idx) => (
                  <button
                    key={idx}
                    type="button"
                    onClick={() => handleSendMessage(prompt)}
                    className="p-3.5 rounded-xl text-left text-xs bg-slate-900/70 hover:bg-slate-900 border border-slate-800 hover:border-indigo-500/50 text-slate-300 hover:text-white transition-all shadow-sm hover:shadow-indigo-500/10 cursor-pointer flex flex-col justify-between"
                  >
                    <span>{prompt}</span>
                    <span className="text-[10px] text-indigo-400 font-medium mt-2 flex items-center gap-1">
                      Спросить <ChevronRight className="w-3 h-3" />
                    </span>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            /* Message Stream */
            <div className="max-w-3xl mx-auto space-y-6">
              {messages.map((msg) => {
                const isUser = msg.role === "user";
                return (
                  <div key={msg.id} className={`flex gap-3.5 ${isUser ? "justify-end" : "justify-start"}`}>
                    {!isUser && (
                      <div className="w-8 h-8 rounded-xl bg-indigo-600/20 border border-indigo-500/30 flex items-center justify-center text-indigo-400 shrink-0 mt-0.5">
                        <SteppeIcon className="w-4 h-4" />
                      </div>
                    )}

                    <div className={`flex flex-col gap-2 max-w-[85%] ${isUser ? "items-end" : "items-start"}`}>
                      {/* Message Bubble */}
                      <div
                        className={`rounded-2xl p-4 text-sm leading-relaxed ${
                          isUser
                            ? "bg-indigo-600 text-white rounded-br-xs shadow-md shadow-indigo-600/20"
                            : "bg-slate-900/80 border border-slate-800 text-slate-100 rounded-bl-xs shadow-sm"
                        }`}
                      >
                        <div className="whitespace-pre-wrap font-sans">{msg.content}</div>

                        {!isUser && (
                          <div className="mt-2 pt-2 border-t border-slate-800/60 flex items-center justify-between text-xs text-slate-500 select-none">
                            <span className="text-[10px] text-slate-500">Локальная модель</span>
                            <button
                              type="button"
                              onClick={() => copyToClipboard(msg.content, msg.id)}
                              className="flex items-center gap-1 hover:text-slate-300 text-[11px] transition-colors cursor-pointer"
                              title="Скопировать ответ"
                            >
                              {copiedId === msg.id ? (
                                <>
                                  <Check className="w-3 h-3 text-emerald-400" />
                                  <span className="text-emerald-400">Скопировано</span>
                                </>
                              ) : (
                                <>
                                  <Copy className="w-3 h-3" />
                                  <span>Копировать</span>
                                </>
                              )}
                            </button>
                          </div>
                        )}
                      </div>

                      {/* Citations Box */}
                      {!isUser && msg.citations && msg.citations.length > 0 && (
                        <div className="w-full space-y-1.5 select-none pt-1">
                          <p className="text-[11px] font-semibold text-slate-400 flex items-center gap-1.5">
                            <FileText className="w-3.5 h-3.5 text-indigo-400" />
                            <span>Источники и цитаты ({msg.citations.length}):</span>
                          </p>
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                            {msg.citations.map((cite, cIdx) => (
                              <div
                                key={cIdx}
                                className="p-2.5 rounded-xl bg-slate-900/60 border border-slate-800 hover:border-indigo-500/40 text-xs transition-colors flex flex-col justify-between gap-1.5 group"
                              >
                                <div>
                                  <div className="flex items-center justify-between gap-1 text-[10px] text-slate-400 mb-1">
                                    <span className="px-1.5 py-0.5 rounded bg-slate-800 text-indigo-300 font-mono">
                                      {cite.source_label || cite.source_type}
                                    </span>
                                    <span className="text-slate-500">{(cite.score * 100).toFixed(0)}% совп.</span>
                                  </div>
                                  <p className="font-medium text-slate-200 line-clamp-1 group-hover:text-indigo-300 transition-colors">
                                    {cite.meeting_title}
                                  </p>
                                  <p className="text-[11px] text-slate-400 italic line-clamp-2 mt-1">
                                    «{cite.snippet}»
                                  </p>
                                </div>

                                <button
                                  type="button"
                                  onClick={() => selectMeeting(cite.meeting_id)}
                                  className="self-end flex items-center gap-1 text-[10px] font-medium text-indigo-400 hover:text-indigo-300 transition-colors cursor-pointer mt-1"
                                >
                                  <span>Открыть протокол</span>
                                  <ExternalLink className="w-2.5 h-2.5" />
                                </button>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}

              {/* Streaming in progress message */}
              {isStreaming && (
                <div className="flex gap-3.5 justify-start">
                  <div className="w-8 h-8 rounded-xl bg-indigo-600/20 border border-indigo-500/30 flex items-center justify-center text-indigo-400 shrink-0 mt-0.5">
                    <SteppeIcon className="w-4 h-4 animate-spin" />
                  </div>

                  <div className="flex flex-col gap-2 max-w-[85%] items-start">
                    <div className="rounded-2xl p-4 text-sm leading-relaxed bg-slate-900/80 border border-slate-800 text-slate-100 rounded-bl-xs shadow-sm">
                      <div className="whitespace-pre-wrap font-sans">
                        {streamingDelta}
                        <span className="inline-block w-1.5 h-4 ml-1 bg-indigo-400 animate-pulse align-middle" />
                      </div>
                    </div>

                    {/* Citations displayed as soon as retrieved */}
                    {streamingCitations.length > 0 && (
                      <div className="w-full space-y-1.5 select-none pt-1">
                        <p className="text-[11px] font-semibold text-slate-400 flex items-center gap-1.5">
                          <FileText className="w-3.5 h-3.5 text-indigo-400" />
                          <span>Найдено источников ({streamingCitations.length}):</span>
                        </p>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                          {streamingCitations.map((cite, cIdx) => (
                            <div
                              key={cIdx}
                              className="p-2 rounded-lg bg-slate-900/60 border border-slate-800 text-xs"
                            >
                              <p className="font-medium text-slate-200 line-clamp-1">{cite.meeting_title}</p>
                              <p className="text-[10px] text-slate-400 italic line-clamp-1 mt-0.5">
                                «{cite.snippet}»
                              </p>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}

              <div ref={messagesEndRef} />
            </div>
          )}
        </div>

        {/* Chat Input Bar */}
        <div className="p-4 border-t border-slate-800/80 bg-slate-900/50 backdrop-blur-md">
          <div className="max-w-3xl mx-auto space-y-2">
            <div className="relative flex items-end gap-2 p-2 rounded-2xl bg-slate-900 border border-slate-700/80 focus-within:border-indigo-500 transition-colors shadow-lg shadow-black/20">
              <textarea
                ref={textareaRef}
                rows={1}
                value={inputPrompt}
                onChange={(e) => setInputPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    handleSendMessage();
                  }
                }}
                placeholder="Задайте вопрос по материалам совещаний (Enter для отправки)..."
                className="flex-1 max-h-36 p-2 text-sm bg-transparent text-white placeholder-slate-400 focus:outline-none resize-none font-sans"
              />

              {isStreaming ? (
                <button
                  type="button"
                  onClick={handleStopStream}
                  className="p-2.5 rounded-xl bg-rose-600 hover:bg-rose-500 text-white transition-colors cursor-pointer shrink-0"
                  title="Остановить ответ"
                >
                  <Square className="w-4 h-4 fill-current" />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => handleSendMessage()}
                  disabled={!inputPrompt.trim()}
                  className="p-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed text-white transition-all shadow-md shadow-indigo-600/25 active:scale-95 cursor-pointer shrink-0"
                  title="Отправить"
                >
                  <Send className="w-4 h-4" />
                </button>
              )}
            </div>

            <div className="flex items-center justify-between text-[11px] text-slate-500 px-1">
              <span>Shift + Enter — перенос строки</span>
              <span>100% локальный поиск по векторной базе SQLite</span>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
};
