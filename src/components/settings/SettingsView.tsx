import React, { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  GearSix as Settings,
  Cpu,
  Broadcast as Radio,
  CheckCircle as CheckCircle2,
  XCircle,
  WarningCircle as AlertCircle,
  ArrowsClockwise as RefreshCw,
  Check,
  Key,
  Eye,
  EyeSlash as EyeOff,
  Sparkle as Sparkles,
  PencilSimple as Edit3,
  List,
  HardDrive,
  Globe,
  Terminal,
  DownloadSimple as Download,
  Trash as Trash2,
  CircleNotch as Loader2,
} from "@phosphor-icons/react";
import { settingsAutosave, loadSettingsConfig } from "../../store/settingsStore";
import { UpdatesCard } from "./UpdatesCard";
import { SaveIndicator } from "./SaveIndicator";
import { CliSettings } from "./CliSettings";
import { cliCheckKey, cliKey, cliStatus } from "../../utils/cliSettings";
import { api } from "../../services/api";
import { useMeetingStore } from "../../store/useMeetingStore";
import { TemplateManager } from "../templates/TemplateManager";
import type { CliCheckResult, SystemConfig, SystemStatus, WhisperStatus } from "../../types";

interface WhisperPreset {
  id: string;
  name: string;
  url: string;
  defaultModel: string;
  requiresKey: boolean;
  description: string;
}

const WHISPER_PRESETS: WhisperPreset[] = [
  {
    id: "groq",
    name: "Groq (Быстрый)",
    url: "https://api.groq.com/openai/v1",
    defaultModel: "whisper-large-v3",
    requiresKey: true,
    description: "Сверхбыстрое распознавание (Groq LPU)",
  },
  {
    id: "openai",
    name: "OpenAI Whisper",
    url: "https://api.openai.com/v1",
    defaultModel: "whisper-1",
    requiresKey: true,
    description: "Облачный сервис OpenAI Whisper",
  },
  {
    id: "local_server",
    name: "Локальный сервер",
    url: "http://localhost:8000/v1",
    defaultModel: "whisper-1",
    requiresKey: false,
    description: "faster-whisper-server или whisper.cpp",
  },
];

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

const DEFAULT_CONFIG: SystemConfig = {
  llm_mode: "api",
  llm_cli_provider: "opencode",
  llm_cli: {},
  llm_base_url: "http://localhost:11434/v1",
  llm_model: "qwen2.5:latest",
  llm_api_key: "",
  whisper_mode: "local",
  whisper_local_model: "small",
  whisper_device: "auto",
  whisper_base_url: "http://localhost:8000/v1",
  whisper_model: "whisper-1",
  whisper_api_key: "",
};

const modelEndpointKey = (value: SystemConfig) => JSON.stringify([value.llm_mode, value.llm_base_url.trim(), value.llm_api_key?.trim() || '']);

export const SettingsView: React.FC = () => {
  const { systemStatus, checkStatus } = useMeetingStore();

  const autosave = useSyncExternalStore(settingsAutosave.subscribe, settingsAutosave.getSnapshot);
  const config = autosave.config || DEFAULT_CONFIG;
  const setConfig = settingsAutosave.change;
  const settingsLoaded = !!autosave.config;

  const [cliChecks, setCliChecks] = useState<Record<string, CliCheckResult>>({});
  useEffect(() => {
    const check = systemStatus?.llm_mode === 'cli' ? systemStatus.cli : undefined;
    if (!check) return;
    setCliChecks(previous => {
      const key = cliCheckKey(check);
      // Preserve a newer explicit check when a cached status poll completes.
      if (previous[key] && Date.parse(previous[key].checked_at) >= Date.parse(check.checked_at)) return previous;
      return { ...previous, [key]: check };
    });
  }, [systemStatus]);
  const [loadError, setLoadError] = useState("");
  const [whisperError, setWhisperError] = useState("");
  const [isLoadingWhisper, setIsLoadingWhisper] = useState(true);
  const [showApiKey, setShowApiKey] = useState(false);
  const [showWhisperApiKey, setShowWhisperApiKey] = useState(false);
  const [whisperDetails, setWhisperDetails] = useState<WhisperStatus | null>(null);
  const [isInstallingEnv, setIsInstallingEnv] = useState(false);
  const [isDownloadingModel, setIsDownloadingModel] = useState<string | null>(null);
  const [manualModelInput, setManualModelInput] = useState(false);
  const [modelList, setModelList] = useState<{ endpoint: string; models: string[] }>({ endpoint: '', models: [] });
  const [loadingModelsKey, setLoadingModelsKey] = useState('');
  const [modelLoadError, setModelLoadError] = useState({ endpoint: '', message: '' });
  const modelRequest = useRef(0);
  const endpointKey = modelEndpointKey(config);
  const availableModels = modelList.endpoint === endpointKey ? modelList.models : [];
  const isLoadingModels = loadingModelsKey === endpointKey;
  const modelsError = modelLoadError.endpoint === endpointKey ? modelLoadError.message : '';
  const [modelToDelete, setModelToDelete] = useState<string | null>(null);

  const localStatus = whisperDetails?.local || systemStatus?.whisper?.local;
  const localCatalog = localStatus?.catalog || [];
  const selectedLocalModel = localCatalog.find((model) => model.id === config.whisper_local_model);
  const selectedEnvInstalled = selectedLocalModel?.env_installed ?? false;
  const selectedLocalReady = selectedEnvInstalled && selectedLocalModel?.downloaded;

  useEffect(() => {
    void loadSettings();
    return () => settingsAutosave.flush();
  }, []);

  useEffect(() => {
    const refreshSharedConfig = () => { void loadSettingsConfig().catch(error => setLoadError(error instanceof Error ? error.message : String(error))); };
    window.addEventListener('focus', refreshSharedConfig);
    return () => window.removeEventListener('focus', refreshSharedConfig);
  }, []);

  const loadSettings = async () => {
    setLoadError("");
    try {
      await loadSettingsConfig();
      if (settingsAutosave.getSnapshot().config?.llm_mode === "api") void fetchModels();
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    }
    // STT discovery must not wait for a remote LLM provider's model listing.
    await Promise.allSettled([checkStatus(), fetchWhisperStatus()]);
  };

  const fetchWhisperStatus = async () => {
    setIsLoadingWhisper(true);
    setWhisperError("");
    try {
      const st = await api.getWhisperStatus();
      setWhisperDetails(st);
      if (st.local?.installing_env) setIsInstallingEnv(true);
      else setIsInstallingEnv(false);
      if (st.local?.downloading) setIsDownloadingModel(st.local.downloading_model ?? null);
      else setIsDownloadingModel(null);
    } catch (e) {
      setWhisperError(e instanceof Error ? e.message : String(e));
    } finally {
      setIsLoadingWhisper(false);
    }
  };

  // Poll when background install or download is running
  useEffect(() => {
    const isBusy =
      whisperDetails?.local?.installing_env ||
      whisperDetails?.local?.downloading ||
      isInstallingEnv ||
      Boolean(isDownloadingModel);

    if (!isBusy) return;

    const timer = setInterval(async () => {
      try {
        const st = await api.getWhisperStatus();
        setWhisperDetails(st);
        setWhisperError("");
        if (!st.local?.installing_env) setIsInstallingEnv(false);
        if (!st.local?.downloading) setIsDownloadingModel(null);
        await checkStatus();
      } catch (e) {
        setWhisperError(e instanceof Error ? e.message : String(e));
        setIsInstallingEnv(false);
        setIsDownloadingModel(null);
        setWhisperDetails(null);
      }
    }, 2000);

    return () => clearInterval(timer);
  }, [whisperDetails, isInstallingEnv, isDownloadingModel]);

  const fetchModels = async () => {
    const current = settingsAutosave.getSnapshot().config;
    if (!current || current.llm_mode !== 'api') return;
    const endpoint = modelEndpointKey(current);
    const request = ++modelRequest.current;
    const stillCurrent = () => request === modelRequest.current && endpoint === modelEndpointKey(settingsAutosave.getSnapshot().config!);
    setLoadingModelsKey(endpoint);
    setModelLoadError({ endpoint, message: '' });
    try {
      let url: URL;
      try { url = new URL(current.llm_base_url.trim()); }
      catch { throw new Error('Укажите полный HTTP или HTTPS URL провайдера'); }
      if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) throw new Error('Укажите полный HTTP или HTTPS URL провайдера');
      const models = await api.listModels({ base_url: current.llm_base_url.trim(), api_key: current.llm_api_key || '' });
      if (stillCurrent()) setModelList({ endpoint, models });
    } catch (error) {
      if (stillCurrent()) setModelLoadError({ endpoint, message: error instanceof Error ? error.message : String(error) });
    } finally {
      if (request === modelRequest.current) setLoadingModelsKey('');
    }
  };

  const applyPreset = (preset: ProviderPreset) => {
    setConfig((prev) => ({
      ...prev,
      llm_base_url: preset.url,
      llm_model: preset.defaultModel,
    }));
  };

  const applyWhisperPreset = (preset: WhisperPreset) => {
    setConfig((prev) => ({
      ...prev,
      whisper_base_url: preset.url,
      whisper_model: preset.defaultModel,
    }));
  };

  const handleInstallEnv = async () => {
    try {
      setIsInstallingEnv(true);
      await api.installWhisperEnv(config.whisper_local_model);
      await fetchWhisperStatus();
    } catch (e: any) {
      alert("Ошибка установки: " + e.message);
      setIsInstallingEnv(false);
    }
  };

  const handleDownloadModel = async (modelId: string) => {
    try {
      setIsDownloadingModel(modelId);
      await api.downloadWhisperModel(modelId);
      await fetchWhisperStatus();
    } catch (e: any) {
      alert("Ошибка скачивания модели: " + e.message);
      setIsDownloadingModel(null);
    }
  };

  const handleDeleteModel = (modelId: string) => {
    setModelToDelete(modelId);
  };

  useEffect(() => {
    if (!autosave.saveRevision) return;
    const timer = setTimeout(() => { void checkStatus(); }, 800);
    return () => clearTimeout(timer);
  }, [autosave.saveRevision, checkStatus]);

  const activeCliCheck = cliChecks[cliKey(config)];
  const ollamaOk = systemStatus?.ollama?.connected;
  const ollamaErr = systemStatus?.ollama?.error;
  const localSelectionText = autosave.stt.status === 'error' ? 'Выбор не сохранён'
    : autosave.stt.status === 'pending' || autosave.stt.status === 'saving' ? 'Сохраняем выбор…'
    : 'Выбрана для следующей записи';

  return (
    <div className="settings-view max-w-5xl mx-auto p-6 space-y-8">
      <div>
        <h2 className="text-xl font-bold text-white tracking-tight flex items-center gap-2">
          <Settings className="w-5 h-5 text-neutral-300" />
          <span>Настройки AI моделей</span>
        </h2>
        <p className="text-xs text-neutral-400 mt-1">
          Настройте LLM провайдера и распознавание речи: локальные Whisper, GigaAM, Wav2Vec2, Vosk или внешний сервис.
        </p>
      </div>

      {loadError && (
        <div role="alert" className="p-3 rounded-xl border border-neutral-700 text-sm text-neutral-300 flex items-center gap-3">
          <span>{loadError}</span>
          <button type="button" onClick={() => void loadSettings()} className="underline shrink-0">Повторить подключение</button>
        </div>
      )}

      <UpdatesCard />
      <p className="text-[11px] text-neutral-400">Изменения сохраняются автоматически. Незавершённые поля остаются в черновике до исправления.</p>
      <fieldset disabled={!settingsLoaded} onBlurCapture={() => settingsAutosave.flush()} className="grid grid-cols-1 md:grid-cols-2 gap-6 min-w-0 disabled:opacity-60">
        {/* LLM Provider Section */}
        <div className="p-6 rounded-2xl bg-neutral-900/60 border border-neutral-800 space-y-5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <div className="w-9 h-9 rounded-xl bg-neutral-800/70 border border-neutral-700 flex items-center justify-center text-neutral-300">
                <Cpu className="w-5 h-5" />
              </div>
              <div>
                <h3 className="text-sm font-semibold text-white">LLM Провайдер</h3>
                <p className="text-[11px] text-neutral-400">Генерация протоколов, чат и аналитика</p>
              </div>
            </div>

            {config.llm_mode === "cli" ? (
              <span className={`flex items-center gap-1 text-xs font-semibold px-2.5 py-1 rounded-full border ${activeCliCheck?.available && activeCliCheck.auth === "authenticated" ? "text-emerald-400 bg-emerald-500/10 border-emerald-500/20" : activeCliCheck?.auth === "required" ? "text-amber-400 bg-amber-500/10 border-amber-500/20" : activeCliCheck && !activeCliCheck.available ? "text-rose-400 bg-rose-500/10 border-rose-500/20" : "text-neutral-400 border-neutral-700"}`}>
                {cliStatus(activeCliCheck)}
              </span>
            ) : ollamaOk ? (
              <span className="flex items-center gap-1 text-emerald-400 text-xs font-semibold px-2.5 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/20">
                <CheckCircle2 className="w-3.5 h-3.5" />
                <span>Подключено</span>
              </span>
            ) : systemStatus?.ollama?.service_online && !systemStatus?.ollama?.model_ready ? (
              <span className="flex items-center gap-1 text-amber-400 text-xs font-semibold px-2.5 py-1 rounded-full bg-amber-500/10 border border-amber-500/20">
                <AlertCircle className="w-3.5 h-3.5" />
                <span>Модель не скачана</span>
              </span>
            ) : (
              <span className="flex items-center gap-1 text-rose-400 text-xs font-semibold px-2.5 py-1 rounded-full bg-rose-500/10 border border-rose-500/20">
                <XCircle className="w-3.5 h-3.5" />
                <span>Недоступно</span>
              </span>
            )}
          </div>

          <SaveIndicator state={autosave.llm} onRetry={() => settingsAutosave.retry('llm')} label="LLM" />
          <div role="radiogroup" aria-label="Способ генерации" className="cli-settings grid grid-cols-2 p-1 rounded-xl bg-neutral-950 border border-neutral-800">
            {([['api', 'API (HTTP)', Globe], ['cli', 'Локальный CLI', Terminal]] as const).map(([mode, label, Icon]) => (
              <label key={mode} className={`min-h-9 flex items-center justify-center gap-2 py-2 px-3 rounded-lg text-xs cursor-pointer ${config.llm_mode === mode ? 'bg-white text-neutral-950 font-semibold shadow-sm' : 'text-neutral-400 hover:text-white hover:bg-neutral-800/50'}`}>
                <input className="sr-only" type="radio" name="llm-mode" value={mode} checked={config.llm_mode === mode} onChange={() => setConfig({ ...config, llm_mode: mode })} />
                <Icon className="w-3.5 h-3.5 shrink-0" />{label}
              </label>
            ))}
          </div>
          {config.llm_mode === 'cli' ? (
            <CliSettings config={config} onChange={setConfig} checks={cliChecks}
              onCheck={(key, result) => setCliChecks(prev => ({ ...prev, [key]: result }))} />
          ) : (<>
          {/* Connection error or model missing message if any */}
          {!ollamaOk && ollamaErr && (
            <div className={`p-2.5 rounded-xl border text-[11px] leading-relaxed ${
              systemStatus?.ollama?.service_online && !systemStatus?.ollama?.model_ready
                ? "bg-amber-500/10 border-amber-500/20 text-amber-300"
                : "bg-rose-500/10 border-rose-500/20 text-rose-300"
            }`}>
              <strong>Внимание:</strong> {ollamaErr}
            </div>
          )}

          <div className="space-y-4 text-xs">
            {/* Quick Presets */}
            <div className="space-y-1.5">
              <label className="text-neutral-300 font-medium flex items-center gap-1.5">
                <Sparkles className="w-3.5 h-3.5 text-neutral-300" />
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
                          ? "bg-white text-neutral-950 shadow-sm "
                          : "bg-neutral-950/70 border border-neutral-800 text-neutral-400 hover:text-white hover:border-neutral-700"
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
              <label className="text-neutral-300 font-medium">Эндпоинт LLM (URL провайдера)</label>
              <input
                type="text"
                aria-invalid={autosave.llm.validation.includes("URL")}
                aria-describedby="llm-save-status"
                value={config.llm_base_url}
                onChange={(e) => setConfig({ ...config, llm_base_url: e.target.value }, true)}
                placeholder="http://localhost:11434/v1"
                className="w-full py-2 px-3 rounded-xl bg-neutral-950 border border-neutral-700 text-white font-mono text-xs focus:outline-none focus:border-neutral-500"
              />
              <p className="text-[11px] text-neutral-400">
                По умолчанию: <code className="text-neutral-300">http://localhost:11434/v1</code>. Любой OpenAI-совместимый URL.
              </p>
            </div>

            {/* API Key / Bearer Token */}
            <div className="space-y-1.5">
              <label className="text-neutral-300 font-medium flex items-center justify-between">
                <span className="flex items-center gap-1.5">
                  <Key className="w-3.5 h-3.5 text-amber-400" />
                  <span>API Ключ / Bearer-токен</span>
                </span>
                <span className="text-[10px] text-neutral-500 font-normal">Необязательно</span>
              </label>
              <div className="relative">
                <input
                  type={showApiKey ? "text" : "password"}
                  value={config.llm_api_key || ""}
                  onChange={(e) => setConfig({ ...config, llm_api_key: e.target.value }, true)}
                  placeholder="sk-... или Bearer токен (пусто для локальной Ollama)"
                  className="w-full py-2 px-3 pr-10 rounded-xl bg-neutral-950 border border-neutral-700 text-white font-mono text-xs focus:outline-none focus:border-neutral-500 placeholder-neutral-600"
                />
                <button
                  type="button"
                  onClick={() => setShowApiKey(!showApiKey)}
                  className="absolute right-3 top-2.5 text-neutral-400 hover:text-white transition-colors"
                  tabIndex={-1}
                >
                  {showApiKey ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                </button>
              </div>
              <p className="text-[11px] text-neutral-400">
                Для Ollama оставьте пустым. Для OpenAI, Groq, OpenRouter укажите ваш ключ.
              </p>
            </div>

            {/* Model Selection */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <label className="text-neutral-300 font-medium">Модель для генерации</label>
                <div className="flex items-center gap-2">
                  {availableModels.length > 0 && (
                    <button
                      type="button"
                      onClick={() => setManualModelInput(!manualModelInput)}
                      className="flex items-center gap-1 text-[11px] text-neutral-400 hover:text-neutral-200"
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
                    disabled={isLoadingModels || !!autosave.llm.validation || autosave.llm.status === "error"}
                    className="flex items-center gap-1 text-[11px] text-neutral-300 hover:text-white"
                  >
                    <RefreshCw className={`w-3 h-3 ${isLoadingModels ? "animate-spin" : ""}`} />
                    <span>Обновить список</span>
                  </button>
                </div>
              </div>

              {modelsError && <p role="alert" className="text-[11px] text-neutral-300">Не удалось загрузить модели: {modelsError}</p>}
              {!manualModelInput && availableModels.length > 0 ? (
                <select
                  aria-invalid={autosave.llm.validation.includes("модель")} aria-describedby="llm-save-status"
                  value={config.llm_model}
                  onChange={(e) => setConfig({ ...config, llm_model: e.target.value })}
                  className="w-full py-2 px-3 rounded-xl bg-neutral-950 border border-neutral-700 text-white font-mono text-xs focus:outline-none focus:border-neutral-500"
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
                  aria-invalid={autosave.llm.validation.includes("модель")} aria-describedby="llm-save-status"
                  value={config.llm_model}
                  onChange={(e) => setConfig({ ...config, llm_model: e.target.value }, true)}
                  placeholder="qwen2.5:latest, gpt-4o-mini, llama-3.3-70b..."
                  className="w-full py-2 px-3 rounded-xl bg-neutral-950 border border-neutral-700 text-white font-mono text-xs focus:outline-none focus:border-neutral-500"
                />
              )}
              <p className="text-[11px] text-neutral-400">
                Рекомендуются: <strong>Qwen 2.5</strong>, <strong>GPT-4o / 4o-mini</strong>, <strong>Llama 3.3</strong>, <strong>DeepSeek</strong>
              </p>
            </div>
          </div>
          </>)}
        </div>

        {/* Whisper Section */}
        <div className="p-6 rounded-2xl bg-neutral-900/60 border border-neutral-800 space-y-5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <div className="w-9 h-9 rounded-xl bg-neutral-800/70 border border-neutral-700 flex items-center justify-center text-neutral-300">
                <Radio className="w-5 h-5" />
              </div>
              <div>
                <h3 className="text-sm font-semibold text-white">Распознавание речи (STT)</h3>
                <p className="text-[11px] text-neutral-400">Распознавание речи в текст</p>
              </div>
            </div>

            {config.whisper_mode === "local" ? (
              selectedLocalReady ? (
                <span className="flex items-center gap-1.5 text-emerald-400 text-xs font-semibold px-2.5 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/20 shrink-0 whitespace-nowrap">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span>
                  <span>Готов локально</span>
                </span>
              ) : !selectedEnvInstalled ? (
                <span className="flex items-center gap-1 text-rose-400 text-xs font-semibold px-2.5 py-1 rounded-full bg-rose-500/10 border border-rose-500/20 shrink-0 whitespace-nowrap">
                  <XCircle className="w-3.5 h-3.5" />
                  <span>Среда не установлена</span>
                </span>
              ) : (
                <span className="flex items-center gap-1 text-amber-400 text-xs font-semibold px-2.5 py-1 rounded-full bg-amber-500/10 border border-amber-500/20 shrink-0 whitespace-nowrap">
                  <AlertCircle className="w-3.5 h-3.5" />
                  <span>Модель не скачана</span>
                </span>
              )
            ) : systemStatus?.whisper?.connected ? (
              <span className="flex items-center gap-1 text-emerald-400 text-xs font-semibold px-2.5 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/20 shrink-0 whitespace-nowrap">
                <CheckCircle2 className="w-3.5 h-3.5" />
                <span>Подключено</span>
              </span>
            ) : (
              <span className="flex items-center gap-1 text-rose-400 text-xs font-semibold px-2.5 py-1 rounded-full bg-rose-500/10 border border-rose-500/20 shrink-0 whitespace-nowrap">
                <XCircle className="w-3.5 h-3.5" />
                <span>Недоступен</span>
              </span>
            )}
          </div>

          <SaveIndicator state={autosave.stt} onRetry={() => settingsAutosave.retry('stt')} label="Распознавание" />

          {/* Mode Switcher */}
          <div className="grid grid-cols-2 p-1 rounded-xl bg-neutral-950 border border-neutral-800 gap-1">
            <button
              type="button"
              onClick={() => setConfig({ ...config, whisper_mode: "local" })}
              className={`flex items-center justify-center gap-2 py-2 px-3 rounded-lg text-xs font-medium transition-all ${
                config.whisper_mode === "local"
                  ? "bg-white text-neutral-950 shadow-sm  font-semibold"
                  : "text-neutral-400 hover:text-white hover:bg-neutral-800/50"
              }`}
            >
              <HardDrive className="w-3.5 h-3.5 shrink-0" />
              <span className="whitespace-nowrap">Локальные модели</span>
            </button>
            <button
              type="button"
              onClick={() => setConfig({ ...config, whisper_mode: "custom" })}
              className={`flex items-center justify-center gap-2 py-2 px-3 rounded-lg text-xs font-medium transition-all ${
                config.whisper_mode === "custom"
                  ? "bg-white text-neutral-950 shadow-sm  font-semibold"
                  : "text-neutral-400 hover:text-white hover:bg-neutral-800/50"
              }`}
            >
              <Globe className="w-3.5 h-3.5 shrink-0" />
              <span className="whitespace-nowrap">Cloud</span>
            </button>
          </div>

          {/* Local Whisper Mode Controls */}
          {config.whisper_mode === "local" ? (
            <div className="space-y-4 text-xs">
              {/* Step 1: Environment */}
              <div className="p-3.5 rounded-xl bg-neutral-950/80 border border-neutral-800/80 space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="w-5 h-5 rounded-full bg-neutral-800/70 border border-neutral-700 flex items-center justify-center text-[10px] font-bold text-neutral-300">1</span>
                    <span className="text-neutral-200 font-medium text-xs">Рабочая среда ({selectedLocalModel?.engine || "STT"})</span>
                  </div>
                  {selectedEnvInstalled ? (
                    <span className="flex items-center gap-1 text-[11px] text-emerald-400 font-medium shrink-0 whitespace-nowrap">
                      <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                      <span>Установлена</span>
                    </span>
                  ) : (
                    <span className="flex items-center gap-1 text-[11px] text-rose-400 font-medium shrink-0 whitespace-nowrap">
                      <XCircle className="w-3.5 h-3.5 shrink-0" />
                      <span>{!localStatus ? "Статус недоступен" : "Не установлена"}</span>
                    </span>
                  )}
                </div>

                {!selectedEnvInstalled ? (
                  <div className="pt-1 flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
                    <p className="text-[11px] text-neutral-400">
                      Зависимости устанавливаются для выбранной модели. Кнопка скачивания также установит нужную среду автоматически.
                    </p>
                    <button
                      type="button"
                      onClick={handleInstallEnv}
                      disabled={isInstallingEnv || localStatus?.installing_env || localStatus?.downloading || selectedLocalModel?.supported === false || !selectedLocalModel}
                      className="flex items-center justify-center gap-1.5 py-1.5 px-3 rounded-lg bg-white hover:bg-neutral-200 text-neutral-950 text-xs font-medium transition-all shrink-0 active:scale-95 disabled:opacity-50"
                    >
                      {isInstallingEnv || whisperDetails?.local?.installing_env ? (
                        <>
                          <Loader2 className="w-3 h-3 animate-spin" />
                          <span>Установка...</span>
                        </>
                      ) : (
                        <>
                          <Download className="w-3 h-3" />
                          <span>Установить среду</span>
                        </>
                      )}
                    </button>
                  </div>
                ) : null}

                {whisperDetails?.local?.installing_env && whisperDetails.local.env_install_progress && (
                  <p className="text-[11px] text-neutral-300 font-mono animate-pulse">
                    {whisperDetails.local.env_install_progress}
                  </p>
                )}
                {whisperDetails?.local?.env_install_error && (
                  <p className="text-[11px] text-rose-400">
                    {whisperDetails.local.env_install_error}
                  </p>
                )}
              </div>

              {/* Step 2: Model selection & download */}
              <div className="p-3.5 rounded-xl bg-neutral-950/80 border border-neutral-800/80 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="w-5 h-5 rounded-full bg-neutral-800/70 border border-neutral-700 flex items-center justify-center text-[10px] font-bold text-neutral-300">2</span>
                    <span className="text-neutral-200 font-medium text-xs">Локальная модель распознавания</span>
                  </div>
                  <span className="text-[10px] text-neutral-400 hidden sm:inline">
                    Хранятся локально в директории данных
                  </span>
                </div>

                <p className="text-[11px] text-neutral-400 mb-3">В Mini одна выбранная модель распознаёт речь во время записи. После остановки готовый транскрипт отправляется на обработку. Выбор сохраняется автоматически и применяется к следующей записи.</p>
                <div className="space-y-2">
                  {whisperError ? (
                    <div role="alert" className="text-neutral-300 space-y-2">
                      <p>{whisperError}</p>
                      <button type="button" disabled={isLoadingWhisper} onClick={() => void fetchWhisperStatus()} className="underline disabled:opacity-50">Повторить подключение</button>
                    </div>
                  ) : localCatalog.length === 0 && (
                    <p className="text-neutral-400">{isLoadingWhisper ? "Загрузка каталога моделей..." : "Каталог моделей пуст. Обновите приложение и повторите подключение."}</p>
                  )}
                  {localCatalog.map((m) => {
                    const isSelected = config.whisper_local_model === m.id;
                    const isDownloading = whisperDetails?.local?.downloading && whisperDetails?.local?.downloading_model === m.id;

                    return (
                      <div
                        key={m.id}
                        onClick={() => m.supported !== false && setConfig({ ...config, whisper_local_model: m.id })}
                        className={`p-3 rounded-xl border transition-all ${m.supported !== false ? "cursor-pointer" : "opacity-60"} ${
                          isSelected
                            ? "bg-neutral-900/60 border-neutral-700 shadow-sm "
                            : "bg-neutral-900/50 border-neutral-800 hover:border-neutral-700"
                        }`}
                      >
                        <div className="flex items-center justify-between gap-3">
                          <div className="flex items-center gap-1.5 min-w-0">
                            <span className="font-semibold text-white text-xs">{m.name}</span>
                          </div>
                          {m.downloaded ? (
                            <span className="text-[10px] text-emerald-400 font-medium flex items-center gap-1 shrink-0 whitespace-nowrap">
                              <Check className="w-3 h-3 shrink-0" />
                              <span>Скачана ({m.disk_size_mb || m.size_mb} МБ)</span>
                            </span>
                          ) : isDownloading ? (
                            <span className="text-[10px] text-neutral-300 font-medium flex items-center gap-1 animate-pulse shrink-0 whitespace-nowrap">
                              <Loader2 className="w-3 h-3 animate-spin shrink-0" />
                              <span>Скачивание...</span>
                            </span>
                          ) : (
                            <span className="text-[10px] text-neutral-500 shrink-0 whitespace-nowrap">~{m.size_mb} МБ</span>
                          )}
                        </div>
                        <p className="text-[11px] text-neutral-400 mt-1 leading-relaxed">{m.description}</p>
                        <div className="flex flex-wrap items-center gap-2 mt-1.5 text-[10px] text-neutral-500">
                          <span>{m.languages?.map((language) => language.toUpperCase()).join(" · ")}</span>
                          <span>{m.streaming === "native" ? "Потоковый движок" : "VAD + порционное распознавание"}</span>
                          <a href={m.source_url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className="text-neutral-400 hover:text-white underline">Источник</a>
                        </div>
                        {m.compatibility_error && <p className="text-[11px] text-amber-400 mt-1">{m.compatibility_error}</p>}

                        {isSelected && (
                          <div className="mt-2.5 pt-2 border-t border-neutral-800 flex items-center justify-between gap-2">
                            {m.downloaded ? (
                              <>
                                <span className="text-[11px] text-emerald-300 font-medium flex items-center gap-1.5 shrink-0 whitespace-nowrap">
                                  <Check className="w-3 h-3 text-emerald-400 shrink-0" />
                                  <span>{m.env_installed ? (whisperDetails?.local?.selected_model === m.id ? "Выбрана для работы" : localSelectionText) : "Скачана — установите среду"}</span>
                                </span>
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleDeleteModel(m.id);
                                  }}
                                  className="text-[11px] text-rose-400 hover:text-rose-300 flex items-center gap-1 shrink-0 px-2 py-0.5 rounded hover:bg-rose-500/10 transition-colors"
                                  title="Удалить модель с диска"
                                >
                                  <Trash2 className="w-3 h-3 shrink-0" />
                                  <span>Удалить</span>
                                </button>
                              </>
                            ) : (
                              <button
                                type="button"
                                disabled={m.supported === false || isDownloading || !!isDownloadingModel || localStatus?.downloading || localStatus?.installing_env || isInstallingEnv}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleDownloadModel(m.id);
                                }}
                                className="w-full flex items-center justify-center gap-1.5 py-1.5 px-3 rounded-lg bg-white hover:bg-neutral-200 text-neutral-950 text-xs font-medium transition-all active:scale-95 disabled:opacity-50"
                              >
                                {isDownloading ? (
                                  <>
                                    <Loader2 className="w-3 h-3 animate-spin shrink-0" />
                                    <span>Скачивается...</span>
                                  </>
                                ) : (
                                  <>
                                    <Download className="w-3 h-3 shrink-0" />
                                    <span>{m.env_installed ? "Скачать модель" : "Скачать и настроить"}</span>
                                  </>
                                )}
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>

                {whisperDetails?.local?.download_progress_text && (
                  <p className="text-[11px] text-neutral-300 font-mono">
                    {whisperDetails.local.download_progress_text}
                  </p>
                )}
                {whisperDetails?.local?.download_error && (
                  <p className="text-[11px] text-rose-400">
                    {whisperDetails.local.download_error}
                  </p>
                )}
              </div>

              {/* Step 3: Hardware device */}
              <div className="space-y-1.5">
                <label className="text-neutral-300 font-medium text-xs">Устройство вычислений (Инференс)</label>
                <select
                  value={config.whisper_device || "auto"}
                  onChange={(e) => setConfig({ ...config, whisper_device: e.target.value })}
                  className="w-full py-2 px-3 rounded-xl bg-neutral-950 border border-neutral-700 text-white font-mono text-xs focus:outline-none focus:border-neutral-500"
                >
                  <option value="auto">Автоопределение (auto — CPU / Apple Silicon)</option>
                  <option value="cpu">Только процессор (CPU)</option>
                </select>
              </div>
            </div>
          ) : (
            /* External Whisper Mode Controls */
            <div className="space-y-4 text-xs">
              {/* Presets */}
              <div className="space-y-2">
                <label className="text-neutral-300 font-medium">Быстрые пресеты провайдеров</label>
                <div className="flex flex-wrap gap-2">
                  {WHISPER_PRESETS.map((p) => {
                    const isSelected = config.whisper_base_url.includes(p.url.replace("https://", "").replace("http://", "").split("/")[0]);
                    return (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => applyWhisperPreset(p)}
                        className={`py-1.5 px-3 rounded-lg border text-xs font-medium transition-all ${
                          isSelected
                            ? "bg-white text-neutral-950 border-neutral-500 shadow-sm "
                            : "bg-neutral-950/80 border-neutral-700 text-neutral-300 hover:text-white hover:border-neutral-600"
                        }`}
                      >
                        {p.name}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Endpoint URL */}
              <div className="space-y-1.5">
                <label className="text-neutral-300 font-medium">Эндпоинт Whisper Сервера</label>
                <input
                  type="text"
                  aria-invalid={autosave.stt.validation.includes("URL")}
                  aria-describedby="stt-save-status"
                  value={config.whisper_base_url}
                  onChange={(e) => setConfig({ ...config, whisper_base_url: e.target.value }, true)}
                  placeholder="https://api.groq.com/openai/v1 или http://localhost:8000/v1"
                  className="w-full py-2 px-3 rounded-xl bg-neutral-950 border border-neutral-700 text-white font-mono text-xs focus:outline-none focus:border-neutral-500"
                />
                <p className="text-[11px] text-neutral-400">
                  Любой OpenAI-совместимый Whisper сервис (Groq, OpenAI, faster-whisper-server, LocalAI)
                </p>
              </div>

              {/* API Key / Bearer Token */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <label className="text-neutral-300 font-medium flex items-center gap-1.5">
                    <Key className="w-3.5 h-3.5 text-neutral-300" />
                    <span>API Ключ / Bearer-токен</span>
                  </label>
                  <span className="text-[11px] text-neutral-500">Для Groq / OpenAI</span>
                </div>
                <div className="relative">
                  <input
                    type={showWhisperApiKey ? "text" : "password"}
                    value={config.whisper_api_key || ""}
                    onChange={(e) => setConfig({ ...config, whisper_api_key: e.target.value }, true)}
                    placeholder="gsk_... / sk-... (для локального сервера оставьте пустым)"
                    className="w-full py-2 pl-3 pr-10 rounded-xl bg-neutral-950 border border-neutral-700 text-white font-mono text-xs focus:outline-none focus:border-neutral-500 placeholder-neutral-600"
                  />
                  <button
                    type="button"
                    onClick={() => setShowWhisperApiKey(!showWhisperApiKey)}
                    className="absolute right-3 top-2.5 text-neutral-400 hover:text-white"
                  >
                    {showWhisperApiKey ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                  </button>
                </div>
                <p className="text-[11px] text-neutral-400">
                  Передаётся в заголовке <code className="text-neutral-300">Authorization: Bearer</code>
                </p>
              </div>

              {/* Whisper Model Name */}
              <div className="space-y-1.5">
                <label className="text-neutral-300 font-medium">Модель Whisper</label>
                <input
                  type="text"
                  aria-invalid={autosave.stt.validation.includes("модель")} aria-describedby="stt-save-status"
                  value={config.whisper_model}
                  onChange={(e) => setConfig({ ...config, whisper_model: e.target.value }, true)}
                  placeholder="whisper-large-v3, whisper-1..."
                  className="w-full py-2 px-3 rounded-xl bg-neutral-950 border border-neutral-700 text-white font-mono text-xs focus:outline-none focus:border-neutral-500"
                />
                <p className="text-[11px] text-neutral-400">
                  Имя модели, отправляемое в поле <code className="text-neutral-300">model</code>
                </p>
              </div>
            </div>
          )}
        </div>
      </fieldset>

      {/* Protocol Templates Section */}
      <TemplateManager />

      {/* Delete Model Confirmation Modal */}
      {modelToDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4 animate-in fade-in duration-150">
          <div className="w-full max-w-md rounded-2xl bg-neutral-900 border border-neutral-700 shadow-2xl p-6 text-neutral-100">
            <div className="flex items-center gap-3 mb-4 text-rose-400">
              <div className="w-10 h-10 rounded-xl bg-rose-500/15 border border-rose-500/30 flex items-center justify-center shrink-0">
                <Trash2 className="w-5 h-5 text-rose-400" />
              </div>
              <div>
                <h3 className="text-base font-bold text-white">Удалить модель?</h3>
                <p className="text-xs text-neutral-400">Освобождение места на диске</p>
              </div>
            </div>
            <p className="text-sm text-neutral-300 mb-6 leading-relaxed">
              Удалить локальные веса модели <span className="font-semibold text-white font-mono">{modelToDelete}</span>? При необходимости её можно будет скачать снова.
            </p>
            <div className="flex items-center justify-end gap-3">
              <button
                type="button"
                onClick={() => setModelToDelete(null)}
                className="px-4 py-2 rounded-xl bg-neutral-800 hover:bg-neutral-700 text-neutral-300 text-xs font-semibold transition-colors"
              >
                Отмена
              </button>
              <button
                type="button"
                onClick={async () => {
                  const id = modelToDelete;
                  setModelToDelete(null);
                  try {
                    await api.deleteWhisperModel(id);
                    await fetchWhisperStatus();
                    await checkStatus();
                  } catch (e: any) {
                    alert("Ошибка удаления: " + e.message);
                  }
                }}
                className="px-4 py-2 rounded-xl bg-rose-600 hover:bg-rose-500 text-white text-xs font-semibold shadow-lg shadow-rose-600/25 transition-colors"
              >
                Удалить модель
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
