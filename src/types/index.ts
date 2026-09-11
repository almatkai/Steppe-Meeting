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
}

export interface SystemStatus {
  ollama: {
    connected: boolean;
    url: string;
    model: string;
    available_models: string[];
    error?: string;
  };
  whisper: {
    connected: boolean;
    url: string;
    model: string;
    error?: string;
  };
}

export interface SystemConfig {
  llm_base_url: string;
  llm_model: string;
  llm_api_key?: string;
  whisper_base_url: string;
  whisper_model: string;
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

