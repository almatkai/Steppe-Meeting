import React, { useEffect } from "react";
import { AppSidebar } from "./components/layout/AppSidebar";
import { AppHeader } from "./components/layout/AppHeader";
import { CreateMeetingWizard } from "./components/wizard/CreateMeetingWizard";
import { MeetingDetailView } from "./components/meeting/MeetingDetailView";
import { HistoryView } from "./components/history/HistoryView";
import { SettingsView } from "./components/settings/SettingsView";
import { GlobalChatView } from "./components/chat/GlobalChatView";
import { useMeetingStore } from "./store/useMeetingStore";

export const App: React.FC = () => {
  const { currentView, loadMeetings, checkStatus } = useMeetingStore();

  useEffect(() => {
    loadMeetings();
    checkStatus();
  }, [loadMeetings, checkStatus]);

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-slate-950 text-slate-100 font-sans">
      {/* Sidebar */}
      <AppSidebar />

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <AppHeader />

        <main className="flex-1 overflow-hidden bg-slate-950/80 flex flex-col">
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
