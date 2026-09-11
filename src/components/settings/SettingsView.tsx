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
  Zap,
  AlertTriangle,
} from "lucide-react";
import { api } from "../../services/api";
import { useMeetingStore } from "../../store/useMeetingStore";
import type { StackPreset, SystemConfig } from "../../types";

interface ProviderPreset {
  id: string;
  name: string;
  url: string;
  defaultModel: string;
  requiresKey: boolean;
  description: string;
}

interface WhisperPreset {
  id: string;
  name: string;
  url: string;
  defaultModel: string;
  description: string;
}

/**
 * Whisper endpoints that speak the OpenAI transcription API. Before the
 * Authorization header was added to the transcription call, only the local
 * option here could ever work.
 */
const WHISPER_PRESETS: WhisperPreset[] = [
  {
    id: "local",
    name: "Локальный Whisper",
    url: "http://localhost:8000/v1",
    defaultModel: "whisper-1",
    description: "faster-whisper-server, whisper.cpp, LocalAI",
  },
  {
    id: "groq",
    name: "Groq",
    url: "https://api.groq.com/openai/v1",
    defaultModel: "whisper-large-v3-turbo",
    description: "Самый быстрый, есть бесплатный тариф",
  },
  {
    id: "openai",
    name: "OpenAI",
    url: "https://api.openai.com/v1",
    defaultModel: "whisper-1",
    description: "Стабильное качество на казахском",
  },
];

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
    whisper_api_key: "",
  });

  const [showApiKey, setShowApiKey] = useState(false);
  const [showWhisperKey, setShowWhisperKey] = useState(false);
  const [manualModelInput, setManualModelInput] = useState(false);
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [isLoadingModels, setIsLoadingModels] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);

  const [stacks, setStacks] = useState<StackPreset[]>([]);
  const [activeStack, setActiveStack] = useState<string>("custom");
  const [stackKey, setStackKey] = useState("");
  const [pendingStack, setPendingStack] = useState<StackPreset | null>(null);
  const [stackError, setStackError] = useState("");
  const [isApplyingStack, setIsApplyingStack] = useState(false);

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

    // Preset loading is separate: an older backend has no /system/presets and
    // must not break the rest of the settings screen.
    try {
      const data = await api.listPresets();
      setStacks(data.presets);
      setActiveStack(data.active);
    } catch (e) {
      console.warn("Provider presets unavailable", e);
    }
  };

  /**
   * Applying a stack configures the LLM and the STT endpoint together with one
   * key, which is the common case for Groq and OpenAI and removes four manual
   * fields the user would otherwise have to get exactly right.
   */
  const handleApplyStack = async (preset: StackPreset, key: string) => {
    setStackError("");
    if (preset.needs_key && !key.trim()) {
      setPendingStack(preset);
      return;
    }

    try {
      setIsApplyingStack(true);
      const cfg = await api.applyPreset(preset.id, key.trim());
      setConfig(cfg);
      setActiveStack(preset.id);
      setPendingStack(null);
      setStackKey("");
      await fetchModels();
      await checkStatus();
    } catch (e: any) {
      setStackError(e.message || String(e));
    } finally {
      setIsApplyingStack(false);
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

      {/* One-click stacks: configure LLM + Whisper together */}
      {stacks.length > 0 && (
        <div className="p-5 rounded-2xl bg-slate-900/60 border border-slate-800 space-y-4">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-amber-500/15 border border-amber-500/20 flex items-center justify-center text-amber-400">
              <Zap className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-white">Быстрая настройка</h3>
              <p className="text-[11px] text-slate-400">
                Настроит LLM и Whisper одновременно, одним ключом
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {stacks.map((preset) => {
              const isActive = activeStack === preset.id;
              return (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() => handleApplyStack(preset, stackKey)}
                  disabled={isApplyingStack}
                  className={`text-left p-3 rounded-xl border transition-all disabled:opacity-50 ${
                    isActive
                      ? "bg-indigo-600/20 border-indigo-500 ring-1 ring-indigo-500/40"
                      : "bg-slate-950/60 border-slate-800 hover:border-slate-600"
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-semibold text-white">{preset.label}</span>
                    {isActive && <CheckCircle2 className="w-3.5 h-3.5 text-indigo-400 shrink-0" />}
                  </div>
                  <p className="text-[11px] text-slate-400 mt-1 leading-relaxed">
                    {preset.description}
                  </p>
                </button>
              );
            })}
          </div>

          {pendingStack && (
            <div className="p-3 rounded-xl bg-slate-950/80 border border-amber-500/30 space-y-2">
              <label className="text-xs text-slate-200 font-medium">
                Введите API-ключ для {pendingStack.label}
              </label>
              <div className="flex flex-col sm:flex-row gap-2">
                <input
                  type="password"
                  value={stackKey}
                  autoFocus
                  onChange={(e) => setStackKey(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleApplyStack(pendingStack, stackKey);
                  }}
                  placeholder="gsk_... или sk-..."
                  className="flex-1 py-2 px-3 rounded-lg bg-slate-950 border border-slate-700 text-white font-mono text-xs focus:outline-none focus:border-indigo-500"
                />
                <button
                  type="button"
                  onClick={() => handleApplyStack(pendingStack, stackKey)}
                  disabled={isApplyingStack || !stackKey.trim()}
                  className="py-2 px-4 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold disabled:opacity-40 shrink-0"
                >
                  {isApplyingStack ? "Применяем..." : "Применить"}
                </button>
              </div>
              {pendingStack.key_url && (
                <p className="text-[11px] text-slate-400">
                  Получить ключ:{" "}
                  <a
                    href={pendingStack.key_url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-indigo-300 hover:text-indigo-200 underline"
                  >
                    {pendingStack.key_url}
                  </a>
                </p>
              )}
            </div>
          )}

          {stackError && (
            <div className="p-2.5 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-300 text-[11px]">
              {stackError}
            </div>
          )}
        </div>
      )}

      {/* ffmpeg availability: silently degrades transcription quality when absent */}
      {systemStatus?.ffmpeg && !systemStatus.ffmpeg.available && (
        <div className="p-3.5 rounded-xl bg-amber-500/10 border border-amber-500/25 flex items-start gap-2.5">
          <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
          <div className="text-[11px] text-amber-200 leading-relaxed">
            <strong className="text-amber-100">ffmpeg не найден.</strong>{" "}
            {systemStatus.ffmpeg.error}
            <br />
            Без него длинные записи не разбиваются на части и видеофайлы
            загружаются целиком, что часто приводит к таймауту.
          </div>
        </div>
      )}

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

          {!whisperOk && systemStatus?.whisper?.error && (
            <div className="p-2.5 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-300 text-[11px] leading-relaxed">
              <strong>Статус:</strong> {systemStatus.whisper.error}
            </div>
          )}

          <div className="space-y-4 text-xs">
            <div className="space-y-1.5">
              <label className="text-slate-300 font-medium flex items-center gap-1.5">
                <Sparkles className="w-3.5 h-3.5 text-cyan-400" />
                <span>Быстрые пресеты</span>
              </label>
              <div className="flex flex-wrap gap-1.5">
                {WHISPER_PRESETS.map((p) => {
                  const isSelected =
                    config.whisper_base_url.replace(/\/+$/, "") === p.url.replace(/\/+$/, "");
                  return (
                    <button
                      key={p.id}
                      type="button"
                      title={p.description}
                      onClick={() =>
                        setConfig({
                          ...config,
                          whisper_base_url: p.url,
                          whisper_model: p.defaultModel,
                        })
                      }
                      className={`px-2.5 py-1 rounded-lg text-[11px] font-medium transition-all ${
                        isSelected
                          ? "bg-cyan-600 text-white shadow-sm shadow-cyan-600/30"
                          : "bg-slate-950/70 border border-slate-800 text-slate-400 hover:text-white hover:border-slate-700"
                      }`}
                    >
                      {p.name}
                    </button>
                  );
                })}
              </div>
            </div>

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
              <label className="text-slate-300 font-medium flex items-center justify-between">
                <span className="flex items-center gap-1.5">
                  <Key className="w-3.5 h-3.5 text-amber-400" />
                  <span>API Ключ Whisper</span>
                </span>
                <span className="text-[10px] text-slate-500 font-normal">Для облачных</span>
              </label>
              <div className="relative">
                <input
                  type={showWhisperKey ? "text" : "password"}
                  value={config.whisper_api_key || ""}
                  onChange={(e) => setConfig({ ...config, whisper_api_key: e.target.value })}
                  placeholder="gsk_... или sk-... (пусто для локального сервера)"
                  className="w-full py-2 px-3 pr-10 rounded-xl bg-slate-950 border border-slate-700 text-white font-mono text-xs focus:outline-none focus:border-indigo-500 placeholder-slate-600"
                />
                <button
                  type="button"
                  onClick={() => setShowWhisperKey(!showWhisperKey)}
                  className="absolute right-3 top-2.5 text-slate-400 hover:text-white transition-colors"
                  tabIndex={-1}
                >
                  {showWhisperKey ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                </button>
              </div>
              <p className="text-[11px] text-slate-400">
                Может отличаться от ключа LLM, если провайдеры разные.
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
