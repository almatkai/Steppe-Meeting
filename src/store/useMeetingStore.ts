import { create } from "zustand";
import type { CliCheckResult, CliModelAccess, Meeting, SystemStatus } from "../types";
import { api } from "../services/api";
import { openMiniWindow, restoreMainWindow } from "../utils/tauriWindow";
import { cliCheckKey, mergeCliCheck } from "../utils/cliSettings";
import { toast } from "sonner";

let meetingRequestVersion = 0;
let meetingSelectionVersion = 0;

interface MeetingStore {
  currentView: "wizard" | "meeting" | "history" | "settings" | "chat";
  activeMeetingId: string | null;
  activeMeeting: Meeting | null;
  meetings: Meeting[];
  isLoading: boolean;
  systemStatus: SystemStatus | null;
  cliChecks: Record<string, CliCheckResult>;
  setCliCheck: (key: string, check: CliCheckResult) => void;
  setCliAccess: (key: string, access: CliModelAccess) => void;
  isMiniMode: boolean;

  setView: (view: "wizard" | "meeting" | "history" | "settings" | "chat") => void;
  setActiveMeetingId: (id: string | null) => void;
  setMiniMode: (isMini: boolean) => Promise<void>;
  loadMeetings: () => Promise<void>;
  selectMeeting: (id: string) => Promise<void>;
  deleteMeeting: (id: string) => Promise<void>;
  checkStatus: () => Promise<void>;
  refreshActiveMeeting: () => Promise<void>;
  stopGeneration: (id: string) => Promise<void>;
}

export const useMeetingStore = create<MeetingStore>((set, get) => ({
  currentView: "wizard",
  activeMeetingId: null,
  activeMeeting: null,
  meetings: [],
  isLoading: false,
  systemStatus: null,
  cliChecks: {},
  setCliCheck: (key, check) => set(state => ({ cliChecks: {
    ...state.cliChecks, [key]: mergeCliCheck(state.cliChecks[key], check),
  } })),
  setCliAccess: (key, access) => set(state => {
    const check = state.cliChecks[key];
    if (!check) return {};
    return { cliChecks: { ...state.cliChecks, [key]: mergeCliCheck(check, { ...check, model_access: access }) } };
  }),
  isMiniMode: false,

  setView: (view) => set({ currentView: view }),

  setActiveMeetingId: (id) => {
    meetingRequestVersion++;
    meetingSelectionVersion++;
    set({ activeMeetingId: id });
    if (id) {
      get().selectMeeting(id);
    } else {
      set({ activeMeeting: null });
    }
  },

  setMiniMode: async (isMini: boolean) => {
    try {
      if (isMini) {
        await openMiniWindow();
      } else {
        await restoreMainWindow();
      }
      set({ isMiniMode: isMini });
    } catch (error) {
      console.error("Failed to switch native windows", error);
      toast.error("Не удалось переключить окно", {
        description: String(error),
      });
    }
  },

  loadMeetings: async () => {
    try {
      set({ isLoading: true });
      const meetings = await api.listMeetings();
      set({ meetings });
    } catch (e) {
      console.error("Failed to load meetings", e);
    } finally {
      set({ isLoading: false });
    }
  },

  selectMeeting: async (id: string) => {
    ++meetingSelectionVersion;
    const version = ++meetingRequestVersion;
    try {
      set({ isLoading: true, activeMeetingId: id });
      const meeting = await api.getMeeting(id);
      if (get().activeMeetingId === id && version === meetingRequestVersion) set({ activeMeeting: meeting, currentView: "meeting" });
    } catch (e) {
      console.error("Failed to fetch meeting", e);
    } finally {
      if (get().activeMeetingId === id && version === meetingRequestVersion) set({ isLoading: false });
    }
  },

  deleteMeeting: async (id: string) => {
    try {
      await api.deleteMeeting(id);
      const meetings = get().meetings.filter((m) => m.id !== id);
      set({ meetings });
      if (get().activeMeetingId === id) {
        set({ activeMeetingId: null, activeMeeting: null, currentView: "history" });
      }
    } catch (e) {
      console.error("Failed to delete meeting", e);
    }
  },

  checkStatus: async () => {
    try {
      const status = await api.getSystemStatus();
      set({ systemStatus: status });
      if (status.llm_mode === 'cli' && status.cli) get().setCliCheck(cliCheckKey(status.cli), status.cli);
    } catch (e) {
      // A failed status request must not leave the sidebar showing an old pass.
      const checked_at = new Date().toISOString();
      set(state => ({ systemStatus: null, cliChecks: Object.fromEntries(
        Object.entries(state.cliChecks).map(([key, check]) => [key, { ...check, checked_at,
          error: 'Не удалось получить состояние CLI. Повторите проверку.' }]),
      ) }));
      console.error("Failed to fetch system status", e);
    }
  },

  stopGeneration: async (id) => {
    const selection = meetingSelectionVersion;
    if (get().activeMeetingId === id) ++meetingRequestVersion;
    const result = await api.stopGeneration(id);
    if (get().activeMeetingId !== id || selection !== meetingSelectionVersion) return;
    ++meetingRequestVersion;
    set(state => ({ activeMeeting: state.activeMeeting?.id === id
      ? { ...state.activeMeeting, status: result.status } : state.activeMeeting }));
    await get().refreshActiveMeeting();
  },

  refreshActiveMeeting: async () => {
    const id = get().activeMeetingId;
    if (!id) return;
    const version = ++meetingRequestVersion;
    try {
      const meeting = await api.getMeeting(id);
      if (get().activeMeetingId === id && version === meetingRequestVersion) set({ activeMeeting: meeting, isLoading: false });
    } catch (e) {
      console.error("Failed to refresh active meeting", e);
    }
  },
}));
