export interface Participant {
  name: string;
  position?: string;
  role?: string;
}

export interface TranscriptSegment {
  index: number;
  speaker: string;
  text: string;
  timestamp_str: string;
  timestamp_start?: number;
  timestamp_end?: number;
}

export interface DecisionItem {
  decision: string;
  responsible?: string;
  deadline?: string;
}

export interface ProtocolTopic {
  topic_name?: string;
  topic?: string;
  speaker?: string;
  discussion?: string;
  decisions: (DecisionItem | string)[];
}

export interface ProtocolAgendaItem {
  topic: string;
  speaker?: string;
  decisions: (DecisionItem | string)[];
}

export interface ProtocolData {
  metadata?: {
    agenda?: string;
    agenda_translated?: string;
    title?: string;
    date?: string;
  };
  participants?: (string | Participant)[];
  topics?: ProtocolTopic[];
  agenda_items?: ProtocolAgendaItem[];
}

export interface SummaryActionItem {
  task: string;
  assignee: string;
  deadline?: string;
}

export interface SummaryTopic {
  topic: string;
  discussion?: string;
  key_arguments?: string[];
  assignments?: SummaryActionItem[];
}

export interface SummaryData {
  executive_summary?: string;
  topics?: SummaryTopic[];
  action_items?: SummaryActionItem[];
  decisions?: Array<{ decision: string } | string>;
  issues_and_risks?: Array<{ type: string; issue: string; impact?: string }>;
}

export interface Meeting {
  id: string;
  title: string;
  created_at: string;
  status: 'draft' | 'transcribing' | 'transcribed' | 'generating' | 'completed' | 'error';
  duration_seconds: number;
  source_language: string;
  agenda: string;
  participants: Participant[];
  audio_filename?: string;
  audio_path?: string;
  transcript_text: string;
  transcript_segments: TranscriptSegment[];
  protocol_ru: ProtocolData;
  protocol_kz: ProtocolData;
  summary_ru: SummaryData;
  summary_kz: SummaryData;
  error_message?: string;
  template_id?: string;
  template_values_ru?: Record<string, any>;
  template_values_kz?: Record<string, any>;
}

export interface WhisperModelCatalogItem {
  id: string;
  name: string;
  size_mb: number;
  description: string;
  recommended: boolean;
  downloaded: boolean;
  disk_size_mb: number;
  is_downloading: boolean;
}

export interface WhisperLocalStatus {
  env_installed: boolean;
  installing_env: boolean;
  env_install_progress: string;
  env_install_error?: string | null;
  selected_model: string;
  model_ready: boolean;
  available_models: string[];
  catalog: WhisperModelCatalogItem[];
  downloading: boolean;
  downloading_model?: string | null;
  download_status: string;
  download_progress_text: string;
  download_error?: string | null;
}

export interface WhisperStatus {
  connected: boolean;
  mode: 'local' | 'custom';
  url?: string;
  model?: string;
  error?: string;
  local?: WhisperLocalStatus;
  custom?: {
    url: string;
    model: string;
    has_api_key: boolean;
  };
}

export interface SystemStatus {
  ollama: {
    connected: boolean;
    service_online?: boolean;
    model_ready?: boolean;
    url: string;
    model: string;
    available_models: string[];
    error?: string;
  };
  whisper: WhisperStatus;
}

export interface SystemConfig {
  llm_base_url: string;
  llm_model: string;
  llm_api_key?: string;
  whisper_mode: 'local' | 'custom';
  whisper_local_model: string;
  whisper_device?: string;
  whisper_base_url: string;
  whisper_model: string;
  whisper_api_key?: string;
}

export interface Citation {
  meeting_id: string;
  meeting_title: string;
  source_type: string;
  source_label: string;
  language: string;
  chunk_index: number;
  snippet: string;
  score: number;
  timestamp_start?: number;
  timestamp_end?: number;
}

export interface ChatMessage {
  id: string;
  session_id: string;
  role: 'user' | 'assistant';
  content: string;
  citations?: Citation[];
  created_at: string;
}

export interface ChatSession {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  message_count?: number;
  last_message?: string | null;
}

export interface ProtocolTemplateSlot {
  key: string;
  label: string;
  value_type: 'string' | 'text' | 'date' | 'list[string]' | 'list[object]';
  required?: boolean;
  source?: string;
  locations?: string[];
  raw_markers?: string[];
  repeat?: {
    kind: string;
    columns?: Array<{ key: string; label: string; cell?: number }>;
    levels?: number;
    original_count?: number;
  } | null;
  omit_when_empty?: boolean;
  inline?: boolean;
}

export interface ProtocolTemplate {
  id: string;
  name: string;
  description?: string;
  additional_prompt?: string;
  detail_level?: 'concise' | 'standard' | 'detailed';
  status?: string;
  docx_path?: string;
  source_docx_path?: string;
  slots: ProtocolTemplateSlot[];
  slots_count: number;
  render_ready: number | boolean;
  has_test_docx: boolean;
  test_values?: Record<string, any>;
  created_at: string;
}

export interface TemplateTestResult {
  template_id: string;
  values: Record<string, any>;
  slots_filled: number;
  has_test_docx: boolean;
  model?: string;
  generation_seconds?: number;
}
