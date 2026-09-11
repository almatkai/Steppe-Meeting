import React, { useEffect, useState } from "react";
import {
  Settings,
  Cpu,
  Radio,
  CheckCircle2,
  XCircle,
  RefreshCw,
  Save,
  Check,
  Server,
  Key,
  Eye,
  EyeOff,
  Sparkles,
  Edit3,
  List,
} from "lucide-react";
import { api } from "../../services/api";
import { useMeetingStore } from "../../store/useMeetingStore";
import type { SystemConfig, SystemStatus } from "../../types";

interface ProviderPreset {
  id: string;
  name: string;
  url: string;
  defaultModel: string;
  requiresKey: boolean;
  description: string;
}

const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: "ollama",
    name: "Ollama (Локально)",
    url: "http://localhost:11434/v1",
    defaultModel: "qwen2.5:latest",
    requiresKey: false,
    description: "Локальный Ollama без ключа",
  },
  {
    id: "openai",
    name: "OpenAI",
    url: "https://api.openai.com/v1",
    defaultModel: "gpt-4o-mini",
    requiresKey: true,
    description: "OpenAI API (GPT-4o, o3-mini)",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    url: "https://openrouter.ai/api/v1",
    defaultModel: "anthropic/claude-3.5-sonnet",
    requiresKey: true,
    description: "OpenRouter со всеми моделями",
  },
  {
    id: "groq",
    name: "Groq",
    url: "https://api.groq.com/openai/v1",
    defaultModel: "llama-3.3-70b-versatile",
    requiresKey: true,
    description: "Сверхбыстрый LPU инференс",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    url: "https://api.deepseek.com/v1",
    defaultModel: "deepseek-chat",
    requiresKey: true,
    description: "DeepSeek V3 / R1",
  },
];

export const SettingsView: React.FC = () => {
  const { systemStatus, checkStatus } = useMeetingStore();

  const [config, setConfig] = useState<SystemConfig>({
    llm_base_url: "http://localhost:11434/v1",
    llm_model: "qwen2.5:latest",
    llm_api_key: "",
    whisper_base_url: "http://localhost:8000/v1",
    whisper_model: "whisper-1",
  });

  const [showApiKey, setShowApiKey] = useState(false);
  const [manualModelInput, setManualModelInput] = useState(false);
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [isLoadingModels, setIsLoadingModels] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);

  useEffect(() => {
    loadSettings();
  }, []);

  const loadSettings = async () => {
    try {
      const cfg = await api.getConfig();
      setConfig(cfg);
      await fetchModels();
      await checkStatus();
    } catch (e) {
      console.error("Failed to load config", e);
    }
  };

  const fetchModels = async () => {
    try {
      setIsLoadingModels(true);
      const models = await api.listModels();
      setAvailableModels(models);
    } catch (e) {
      console.error("Failed to fetch models", e);
    } finally {
      setIsLoadingModels(false);
    }
  };

  const applyPreset = (preset: ProviderPreset) => {
    setConfig((prev) => ({
      ...prev,
      llm_base_url: preset.url,
      llm_model: preset.defaultModel,
    }));
  };

  const handleSave = async () => {
    try {
      setIsSaving(true);
      await api.saveConfig(config);
      await checkStatus();
      await fetchModels();
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 2500);
    } catch (e: any) {
      alert("Не удалось сохранить настройки: " + e.message);
    } finally {
      setIsSaving(false);
    }
  };

  const ollamaOk = systemStatus?.ollama?.connected;
  const ollamaErr = systemStatus?.ollama?.error;
  const whisperOk = systemStatus?.whisper?.connected;

  return (
    <div className="max-w-4xl mx-auto p-6 space-y-8">
      <div>
        <h2 className="text-xl font-bold text-white tracking-tight flex items-center gap-2">
          <Settings className="w-5 h-5 text-indigo-400" />
          <span>Настройки AI моделей</span>
        </h2>
        <p className="text-xs text-slate-400 mt-1">
          Настройте подключение к любому LLM провайдеру (локальная Ollama, OpenAI, Groq, OpenRouter и др.) и сервису распознавания речи Whisper.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* LLM Provider Section */}
        <div className="p-6 rounded-2xl bg-slate-900/60 border border-slate-800 space-y-5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <div className="w-9 h-9 rounded-xl bg-indigo-600/15 border border-indigo-500/20 flex items-center justify-center text-indigo-400">
                <Cpu className="w-5 h-5" />
              </div>
              <div>
                <h3 className="text-sm font-semibold text-white">LLM Провайдер</h3>
                <p className="text-[11px] text-slate-400">Генерация протоколов, чат и аналитика</p>
              </div>
            </div>

            {ollamaOk ? (
              <span className="flex items-center gap-1 text-emerald-400 text-xs font-semibold px-2.5 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/20">
                <CheckCircle2 className="w-3.5 h-3.5" />
                <span>Подключено</span>
              </span>
            ) : (
              <span className="flex items-center gap-1 text-rose-400 text-xs font-semibold px-2.5 py-1 rounded-full bg-rose-500/10 border border-rose-500/20">
                <XCircle className="w-3.5 h-3.5" />
                <span>Недоступно</span>
              </span>
            )}
          </div>

          {/* Connection error message if any */}
          {!ollamaOk && ollamaErr && (
            <div className="p-2.5 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-300 text-[11px] leading-relaxed">
              <strong>Статус:</strong> {ollamaErr}
            </div>
          )}

          <div className="space-y-4 text-xs">
            {/* Quick Presets */}
            <div className="space-y-1.5">
              <label className="text-slate-300 font-medium flex items-center gap-1.5">
                <Sparkles className="w-3.5 h-3.5 text-indigo-400" />
                <span>Быстрые пресеты</span>
              </label>
              <div className="flex flex-wrap gap-1.5">
                {PROVIDER_PRESETS.map((p) => {
                  const isSelected =
                    config.llm_base_url.replace(/\/+$/, "") === p.url.replace(/\/+$/, "");
                  return (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => applyPreset(p)}
                      className={`px-2.5 py-1 rounded-lg text-[11px] font-medium transition-all ${
                        isSelected
                          ? "bg-indigo-600 text-white shadow-sm shadow-indigo-600/30"
                          : "bg-slate-950/70 border border-slate-800 text-slate-400 hover:text-white hover:border-slate-700"
                      }`}
                    >
                      {p.name}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Base URL */}
            <div className="space-y-1.5">
              <label className="text-slate-300 font-medium">Эндпоинт LLM (URL провайдера)</label>
              <input
                type="text"
                value={config.llm_base_url}
                onChange={(e) => setConfig({ ...config, llm_base_url: e.target.value })}
                placeholder="http://localhost:11434/v1"
                className="w-full py-2 px-3 rounded-xl bg-slate-950 border border-slate-700 text-white font-mono text-xs focus:outline-none focus:border-indigo-500"
              />
              <p className="text-[11px] text-slate-400">
                По умолчанию: <code className="text-indigo-300">http://localhost:11434/v1</code>. Любой OpenAI-совместимый URL.
              </p>
            </div>

            {/* API Key / Bearer Token */}
            <div className="space-y-1.5">
              <label className="text-slate-300 font-medium flex items-center justify-between">
                <span className="flex items-center gap-1.5">
                  <Key className="w-3.5 h-3.5 text-amber-400" />
                  <span>API Ключ / Bearer-токен</span>
                </span>
                <span className="text-[10px] text-slate-500 font-normal">Необязательно</span>
              </label>
              <div className="relative">
                <input
                  type={showApiKey ? "text" : "password"}
                  value={config.llm_api_key || ""}
                  onChange={(e) => setConfig({ ...config, llm_api_key: e.target.value })}
                  placeholder="sk-... или Bearer токен (пусто для локальной Ollama)"
                  className="w-full py-2 px-3 pr-10 rounded-xl bg-slate-950 border border-slate-700 text-white font-mono text-xs focus:outline-none focus:border-indigo-500 placeholder-slate-600"
                />
                <button
                  type="button"
                  onClick={() => setShowApiKey(!showApiKey)}
                  className="absolute right-3 top-2.5 text-slate-400 hover:text-white transition-colors"
                  tabIndex={-1}
                >
                  {showApiKey ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                </button>
              </div>
              <p className="text-[11px] text-slate-400">
                Для Ollama оставьте пустым. Для OpenAI, Groq, OpenRouter укажите ваш ключ.
              </p>
            </div>

            {/* Model Selection */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <label className="text-slate-300 font-medium">Модель для генерации</label>
                <div className="flex items-center gap-2">
                  {availableModels.length > 0 && (
                    <button
                      type="button"
                      onClick={() => setManualModelInput(!manualModelInput)}
                      className="flex items-center gap-1 text-[11px] text-slate-400 hover:text-slate-200"
                    >
                      {manualModelInput ? (
                        <>
                          <List className="w-3 h-3" />
                          <span>Из списка</span>
                        </>
                      ) : (
                        <>
                          <Edit3 className="w-3 h-3" />
                          <span>Ввести вручную</span>
                        </>
                      )}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={fetchModels}
                    disabled={isLoadingModels}
                    className="flex items-center gap-1 text-[11px] text-indigo-400 hover:text-indigo-300"
                  >
                    <RefreshCw className={`w-3 h-3 ${isLoadingModels ? "animate-spin" : ""}`} />
                    <span>Обновить список</span>
                  </button>
                </div>
              </div>

              {!manualModelInput && availableModels.length > 0 ? (
                <select
                  value={config.llm_model}
                  onChange={(e) => setConfig({ ...config, llm_model: e.target.value })}
                  className="w-full py-2 px-3 rounded-xl bg-slate-950 border border-slate-700 text-white font-mono text-xs focus:outline-none focus:border-indigo-500"
                >
                  {!availableModels.includes(config.llm_model) && (
                    <option value={config.llm_model}>{config.llm_model} (текущая)</option>
                  )}
                  {availableModels.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  type="text"
                  value={config.llm_model}
                  onChange={(e) => setConfig({ ...config, llm_model: e.target.value })}
                  placeholder="qwen2.5:latest, gpt-4o-mini, llama-3.3-70b..."
                  className="w-full py-2 px-3 rounded-xl bg-slate-950 border border-slate-700 text-white font-mono text-xs focus:outline-none focus:border-indigo-500"
                />
              )}
              <p className="text-[11px] text-slate-400">
                Рекомендуются: <strong>Qwen 2.5</strong>, <strong>GPT-4o / 4o-mini</strong>, <strong>Llama 3.3</strong>, <strong>DeepSeek</strong>
              </p>
            </div>
          </div>
        </div>

        {/* Whisper Section */}
        <div className="p-6 rounded-2xl bg-slate-900/60 border border-slate-800 space-y-5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <div className="w-9 h-9 rounded-xl bg-cyan-600/15 border border-cyan-500/20 flex items-center justify-center text-cyan-400">
                <Radio className="w-5 h-5" />
              </div>
              <div>
                <h3 className="text-sm font-semibold text-white">Whisper STT</h3>
                <p className="text-[11px] text-slate-400">Распознавание речи в текст</p>
              </div>
            </div>

            {whisperOk ? (
              <span className="flex items-center gap-1 text-emerald-400 text-xs font-semibold px-2.5 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/20">
                <CheckCircle2 className="w-3.5 h-3.5" />
                <span>Готов</span>
              </span>
            ) : (
              <span className="flex items-center gap-1 text-rose-400 text-xs font-semibold px-2.5 py-1 rounded-full bg-rose-500/10 border border-rose-500/20">
                <XCircle className="w-3.5 h-3.5" />
                <span>Недоступен</span>
              </span>
            )}
          </div>

          <div className="space-y-4 text-xs">
            <div className="space-y-1.5">
              <label className="text-slate-300 font-medium">Эндпоинт Whisper Сервера</label>
              <input
                type="text"
                value={config.whisper_base_url}
                onChange={(e) => setConfig({ ...config, whisper_base_url: e.target.value })}
                placeholder="http://localhost:8000/v1"
                className="w-full py-2 px-3 rounded-xl bg-slate-950 border border-slate-700 text-white font-mono text-xs focus:outline-none focus:border-indigo-500"
              />
              <p className="text-[11px] text-slate-400">
                OpenAI-совместимый Whisper сервис (faster-whisper-server, whisper.cpp, LocalAI и др.)
              </p>
            </div>

            <div className="space-y-1.5">
              <label className="text-slate-300 font-medium">Модель Whisper</label>
              <input
                type="text"
                value={config.whisper_model}
                onChange={(e) => setConfig({ ...config, whisper_model: e.target.value })}
                placeholder="whisper-1 или large-v3"
                className="w-full py-2 px-3 rounded-xl bg-slate-950 border border-slate-700 text-white font-mono text-xs focus:outline-none focus:border-indigo-500"
              />
              <p className="text-[11px] text-slate-400">
                Имя модели, отправляемое в поле <code className="text-cyan-300">model</code>
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Save Action Bar */}
      <div className="flex items-center justify-between p-4 rounded-xl bg-slate-900 border border-slate-800">
        <div className="flex items-center gap-2 text-xs text-slate-400">
          <Server className="w-4 h-4 text-indigo-400" />
          <span>Локальный бэкенд запущен на порту 8008</span>
        </div>

        <button
          type="button"
          onClick={handleSave}
          disabled={isSaving}
          className="flex items-center gap-2 py-2.5 px-6 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold transition-all shadow-md shadow-indigo-600/25 active:scale-95 disabled:opacity-50"
        >
          {saveSuccess ? (
            <>
              <Check className="w-4 h-4 text-emerald-300" />
              <span>Сохранено!</span>
            </>
          ) : (
            <>
              <Save className="w-4 h-4" />
              <span>{isSaving ? "Сохранение..." : "Сохранить настройки"}</span>
            </>
          )}
        </button>
      </div>
    </div>
  );
};
