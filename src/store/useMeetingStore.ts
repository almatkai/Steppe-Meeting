import { create } from "zustand";
import type { Meeting, SystemStatus } from "../types";
import { api } from "../services/api";

interface MeetingStore {
  currentView: "wizard" | "meeting" | "history" | "settings" | "chat";
  activeMeetingId: string | null;
  activeMeeting: Meeting | null;
  meetings: Meeting[];
  isLoading: boolean;
  systemStatus: SystemStatus | null;

  setView: (view: "wizard" | "meeting" | "history" | "settings" | "chat") => void;
  setActiveMeetingId: (id: string | null) => void;
  loadMeetings: () => Promise<void>;
  selectMeeting: (id: string) => Promise<void>;
  deleteMeeting: (id: string) => Promise<void>;
  checkStatus: () => Promise<void>;
  refreshActiveMeeting: () => Promise<void>;
}

export const useMeetingStore = create<MeetingStore>((set, get) => ({
  currentView: "wizard",
  activeMeetingId: null,
  activeMeeting: null,
  meetings: [],
  isLoading: false,
  systemStatus: null,

  setView: (view) => set({ currentView: view }),

  setActiveMeetingId: (id) => {
    set({ activeMeetingId: id });
    if (id) {
      get().selectMeeting(id);
    } else {
      set({ activeMeeting: null });
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
    try {
      set({ isLoading: true, activeMeetingId: id });
      const meeting = await api.getMeeting(id);
      set({ activeMeeting: meeting, currentView: "meeting" });
    } catch (e) {
      console.error("Failed to fetch meeting", e);
    } finally {
      set({ isLoading: false });
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
    } catch (e) {
      console.error("Failed to fetch system status", e);
    }
  },

  refreshActiveMeeting: async () => {
    const id = get().activeMeetingId;
    if (!id) return;
    try {
      const meeting = await api.getMeeting(id);
      set({ activeMeeting: meeting });
    } catch (e) {
      console.error("Failed to refresh active meeting", e);
    }
  },
}));
