import React, { useState, useRef, useEffect } from "react";
import {
  Send,
  X,
  Bot,
  User,
  Trash2,
  CornerDownLeft,
  Loader2,
} from "lucide-react";
import { SteppeIcon } from "../ui/SteppeIcon";
import { api } from "../../services/api";

interface Message {
  role: "user" | "assistant";
  content: string;
}

interface AiChatDrawerProps {
  meetingId: string;
  isOpen: boolean;
  onClose: () => void;
  contextProtocol?: string;
  contextSummary?: string;
}

export const AiChatDrawer: React.FC<AiChatDrawerProps> = ({
  meetingId,
  isOpen,
  onClose,
  contextProtocol,
  contextSummary,
}) => {
  const [messages, setMessages] = useState<Message[]>([
    {
      role: "assistant",
      content:
        "Здравствуйте! Я ваш локальный AI-ассистент по этому совещанию. Могу ответить на любые вопросы по стенограмме, помочь составить письмо или уточнить решения.",
    },
  ]);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, isStreaming]);

  if (!isOpen) return null;

  const handleSend = async (textToSend?: string) => {
    const query = textToSend || input;
    if (!query.trim() || isStreaming) return;

    const newMessages: Message[] = [...messages, { role: "user", content: query.trim() }];
    setMessages(newMessages);
    setInput("");
    setIsStreaming(true);

    // Placeholder assistant message for streaming
    setMessages((prev) => [...prev, { role: "assistant", content: "" }]);

    await api.chatStream(
      meetingId,
      newMessages,
      { protocol: contextProtocol, summary: contextSummary },
      (chunk) => {
        setMessages((prev) => {
          const updated = [...prev];
          const lastIdx = updated.length - 1;
          updated[lastIdx] = {
            ...updated[lastIdx],
            content: updated[lastIdx].content + chunk,
          };
          return updated;
        });
      },
      (err) => {
        setMessages((prev) => {
          const updated = [...prev];
          const lastIdx = updated.length - 1;
          if (lastIdx >= 0 && updated[lastIdx].role === "assistant") {
            updated[lastIdx] = {
              role: "assistant",
              content: `Ошибка локальной модели: ${err}`,
            };
            return updated;
          }
          return [
            ...prev,
            { role: "assistant", content: `Ошибка локальной модели: ${err}` },
          ];
        });
        setIsStreaming(false);
      }
    );

    setIsStreaming(false);
  };

  const quickPrompts = [
    "Сделай список ключевых поручений",
    "Напиши драфт follow-up письма участникам",
    "Были ли спорные моменты на встрече?",
  ];

  return (
    <div className="fixed right-0 top-16 bottom-0 w-96 bg-slate-900/95 backdrop-blur-xl border-l border-slate-800 shadow-2xl z-40 flex flex-col select-none">
      {/* Drawer Header */}
      <div className="h-14 px-4 border-b border-slate-800 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg bg-indigo-600/20 border border-indigo-500/30 flex items-center justify-center text-indigo-400">
            <SteppeIcon className="w-4 h-4" />
          </div>
          <div>
            <h3 className="text-xs font-semibold text-white">AI Ассистент</h3>
            <p className="text-[10px] text-slate-400 font-mono">AI Copilot</p>
          </div>
        </div>

        <div className="flex items-center gap-1">
          <button
            onClick={() =>
              setMessages([
                {
                  role: "assistant",
                  content: "Диалог очищен. Чем я могу помочь?",
                },
              ])
            }
            className="p-1.5 rounded-lg text-slate-400 hover:text-rose-400 hover:bg-slate-800 transition-colors"
            title="Очистить историю"
          >
            <Trash2 className="w-4 h-4" />
          </button>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Messages Scroll Area */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3.5 select-text text-xs">
        {messages.map((m, idx) => (
          <div
            key={idx}
            className={`flex gap-2.5 ${m.role === "user" ? "justify-end" : "justify-start"}`}
          >
            {m.role === "assistant" && (
              <div className="w-6 h-6 rounded-md bg-indigo-600/20 border border-indigo-500/30 flex items-center justify-center text-indigo-400 shrink-0 mt-0.5">
                <Bot className="w-3.5 h-3.5" />
              </div>
            )}
            <div
              className={`p-3 rounded-2xl max-w-[82%] leading-relaxed whitespace-pre-wrap ${
                m.role === "user"
                  ? "bg-indigo-600 text-white rounded-tr-sm shadow-md"
                  : "bg-slate-800/80 border border-slate-700/60 text-slate-200 rounded-tl-sm shadow-sm"
              }`}
            >
              {m.content || (isStreaming && idx === messages.length - 1 ? (
                <span className="inline-flex items-center gap-1 text-slate-400">
                  <Loader2 className="w-3 h-3 animate-spin" />
                  Печатает...
                </span>
              ) : null)}
            </div>
            {m.role === "user" && (
              <div className="w-6 h-6 rounded-md bg-slate-700 flex items-center justify-center text-slate-300 shrink-0 mt-0.5">
                <User className="w-3.5 h-3.5" />
              </div>
            )}
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>

      {/* Quick suggestions */}
      <div className="px-3 py-2 border-t border-slate-800/60 flex flex-wrap gap-1.5 bg-slate-950/30">
        {quickPrompts.map((p, idx) => (
          <button
            key={idx}
            type="button"
            onClick={() => handleSend(p)}
            className="text-[11px] py-1 px-2.5 rounded-lg bg-slate-800/80 hover:bg-slate-700/80 border border-slate-700/50 text-slate-300 transition-colors truncate max-w-full text-left"
          >
            {p}
          </button>
        ))}
      </div>

      {/* Input Form */}
      <div className="p-3 border-t border-slate-800 bg-slate-950">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleSend();
          }}
          className="flex items-center gap-2"
        >
          <input
            type="text"
            placeholder="Спросите AI об этом совещании..."
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={isStreaming}
            className="flex-1 py-2 px-3 text-xs rounded-xl bg-slate-900 border border-slate-700 text-white placeholder-slate-400 focus:outline-none focus:border-indigo-500"
          />
          <button
            type="submit"
            disabled={!input.trim() || isStreaming}
            className="p-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white disabled:opacity-40 transition-all shrink-0"
          >
            <Send className="w-4 h-4" />
          </button>
        </form>
      </div>
    </div>
  );
};
