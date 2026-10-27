import React, { useEffect } from "react";
import { AppSidebar } from "./components/layout/AppSidebar";
import { AppHeader } from "./components/layout/AppHeader";
import { CreateMeetingWizard } from "./components/wizard/CreateMeetingWizard";
import { MeetingDetailView } from "./components/meeting/MeetingDetailView";
import { HistoryView } from "./components/history/HistoryView";
import { SettingsView } from "./components/settings/SettingsView";
import { GlobalChatView } from "./components/chat/GlobalChatView";
import { MiniStatusBar } from "./components/minimode/MiniStatusBar";
import { useMeetingStore } from "./store/useMeetingStore";
import { isMiniWindow, isTauriEnvironment } from "./utils/tauriWindow";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Toaster } from "sonner";

export const App: React.FC = () => {
  const { currentView, loadMeetings, checkStatus, selectMeeting } = useMeetingStore();
  const isMini = isMiniWindow();

  useEffect(() => {
    if (!isMini) {
      loadMeetings();
      checkStatus();
      const meetingId = new URLSearchParams(window.location.search).get("meeting");
      if (meetingId) void selectMeeting(meetingId);
    }
  }, [isMini, loadMeetings, checkStatus, selectMeeting]);

  useEffect(() => {
    if (isMini || !isTauriEnvironment()) return;
    let disposed = false;
    let unlisten: UnlistenFn | undefined;
    void listen<string>("mini-recording-saved", (event) => {
      void loadMeetings();
      void selectMeeting(event.payload);
    }).then((cleanup) => {
      if (disposed) cleanup();
      else unlisten = cleanup;
    }).catch(console.error);
    return () => { disposed = true; unlisten?.(); };
  }, [isMini, loadMeetings, selectMeeting]);

  // If this window is the dedicated secondary Mini Mode window
  if (isMini) {
    return <MiniStatusBar />;
  }

  return (
    <div className="relative flex h-screen w-screen overflow-hidden bg-neutral-950 text-neutral-100 font-sans">
      <Toaster position="bottom-right" richColors theme="dark" closeButton />

      {/* Sidebar */}
      <AppSidebar />

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <AppHeader />

        <main className="flex-1 overflow-hidden bg-neutral-950/80 flex flex-col">
          {currentView === "wizard" && <div className="flex-1 overflow-y-auto"><CreateMeetingWizard /></div>}
          {currentView === "meeting" && <div className="flex-1 overflow-y-auto"><MeetingDetailView /></div>}
          {currentView === "history" && <div className="flex-1 overflow-y-auto"><HistoryView /></div>}
          {currentView === "settings" && <div className="flex-1 overflow-y-auto"><SettingsView /></div>}
          {currentView === "chat" && <div className="flex-1 overflow-hidden"><GlobalChatView /></div>}
        </main>
      </div>
    </div>
  );
};
