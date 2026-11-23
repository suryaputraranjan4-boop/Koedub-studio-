import React, { useState } from 'react';
import {
  Activity,
  AudioWaveform,
  Box,
  CheckSquare,
  Cpu,
  FileAudio,
  FolderKanban,
  Home,
  Languages,
  Menu,
  Mic,
  Plus,
  ScanSearch,
  Settings,
  Users,
  X,
} from 'lucide-react';
import type { ScreenId } from '../types/domain';
import { useStudio } from '../state/StudioContext';

interface NavItem {
  id: ScreenId;
  label: string;
  shortLabel: string;
  group: 'Workspace' | 'Pipeline' | 'Studio' | 'System';
  icon: React.ComponentType<{ className?: string }>;
}

export const NAV_ITEMS: readonly NavItem[] = [
  { id: 'home', label: 'Home Dashboard', shortLabel: 'Home', group: 'Workspace', icon: Home },
  { id: 'projects', label: 'Projects', shortLabel: 'Projects', group: 'Workspace', icon: FolderKanban },
  { id: 'import', label: 'Media Import', shortLabel: 'Import', group: 'Pipeline', icon: FileAudio },
  { id: 'analysis', label: 'Media Analysis', shortLabel: 'Analysis', group: 'Pipeline', icon: ScanSearch },
  { id: 'processing', label: 'Processing Center', shortLabel: 'Pipeline', group: 'Pipeline', icon: Activity },
  { id: 'characters', label: 'Character Studio', shortLabel: 'Characters', group: 'Studio', icon: Users },
  { id: 'voices', label: 'Voice Library', shortLabel: 'Voices', group: 'Studio', icon: Mic },
  { id: 'translation', label: 'Translation Studio', shortLabel: 'Translate', group: 'Studio', icon: Languages },
  { id: 'audio_studio', label: 'Audio Studio', shortLabel: 'Studio', group: 'Studio', icon: AudioWaveform },
  { id: 'qa', label: 'Quality Assurance', shortLabel: 'QA', group: 'Studio', icon: CheckSquare },
  { id: 'models', label: 'Model Manager', shortLabel: 'Models', group: 'System', icon: Cpu },
  { id: 'settings', label: 'Settings & Storage', shortLabel: 'Settings', group: 'System', icon: Settings },
] as const;

const MOBILE_BOTTOM_TABS: ScreenId[] = ['home', 'projects', 'processing', 'audio_studio'];

export function AppShell({ children }: { children: React.ReactNode }) {
  const {
    activeScreen,
    setActiveScreen,
    projects,
    activeProjectId,
    setActiveProjectId,
  } = useStudio();
  const [drawerOpen, setDrawerOpen] = useState(false);

  const activeNavItem = NAV_ITEMS.find((n) => n.id === activeScreen) ?? NAV_ITEMS[0];
  const groups: Array<NavItem['group']> = ['Workspace', 'Pipeline', 'Studio', 'System'];

  const handleNavigate = (screen: ScreenId) => {
    setActiveScreen(screen);
    setDrawerOpen(false);
  };

  return (
    <div className="min-h-screen bg-[#F7F8FA] text-slate-900 flex flex-col lg:flex-row">
      {/* Desktop Left Sidebar */}
      <aside
        aria-label="Primary studio navigation"
        className="hidden lg:flex lg:flex-col lg:w-64 lg:shrink-0 bg-white border-r border-slate-200 sticky top-0 h-screen"
      >
        <div className="h-14 px-5 flex items-center border-b border-slate-200">
          <button
            type="button"
            onClick={() => handleNavigate('home')}
            className="text-base font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0 flex items-center gap-2"
          >
            <Box className="w-4 h-4 text-blue-700" aria-hidden="true" />
            <span>KoeDub Studio</span>
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-5">
          {groups.map((groupName) => (
            <div key={groupName}>
              <p className="px-2.5 mb-1.5 text-[11px] font-medium text-slate-400 tracking-normal">
                {groupName}
              </p>
              <ul className="space-y-0.5">
                {NAV_ITEMS.filter((item) => item.group === groupName).map((item) => {
                  const Icon = item.icon;
                  const isActive = item.id === activeScreen;
                  return (
                    <li key={item.id}>
                      <button
                        type="button"
                        onClick={() => handleNavigate(item.id)}
                        aria-current={isActive ? 'page' : undefined}
                        className={`w-full min-h-[40px] px-2.5 py-2 rounded-lg flex items-center gap-2.5 text-sm font-medium transition-colors whitespace-nowrap ${
                          isActive
                            ? 'bg-blue-50 text-blue-800'
                            : 'text-slate-700 hover:bg-slate-100 hover:text-slate-900'
                        }`}
                      >
                        <Icon
                          className={`w-4 h-4 shrink-0 ${
                            isActive ? 'text-blue-700' : 'text-slate-500'
                          }`}
                          aria-hidden="true"
                        />
                        <span className="truncate">{item.label}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>

        <div className="p-4 border-t border-slate-200 text-xs text-slate-500">
          <p className="font-medium text-slate-700">Local-First Mode</p>
          <p className="mt-0.5 leading-snug">
            IndexedDB & isolated local media storage. Zero automatic cloud uploads.
          </p>
        </div>
      </aside>

      {/* Main Column */}
      <div className="flex-1 min-w-0 flex flex-col">
        {/* Compact Top Bar (Mobile: 52px; Desktop: 56px) */}
        <header className="sticky top-0 z-30 h-[52px] lg:h-14 bg-white/95 backdrop-blur border-b border-slate-200 px-4 lg:px-8 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setDrawerOpen(true)}
              aria-label="Open all studio screens menu"
              className="lg:hidden min-h-[44px] min-w-[44px] -ml-2 flex items-center justify-center text-slate-700 hover:text-slate-900 rounded-lg"
            >
              <Menu className="w-5 h-5" aria-hidden="true" />
            </button>
            <div className="flex items-center gap-2 min-w-0 text-sm">
              <span className="font-semibold text-slate-900 truncate">
                {activeNavItem.label}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-3 shrink-0">
            <div className="hidden sm:flex items-center gap-2">
              <label htmlFor="active-project-select" className="sr-only">
                Active project
              </label>
              <select
                id="active-project-select"
                aria-label="Active project"
                value={activeProjectId ?? ''}
                onChange={(e) => void setActiveProjectId(e.target.value || null)}
                className="h-9 max-w-[220px] rounded-lg border border-slate-200 bg-slate-50 px-3 text-xs font-medium text-slate-800 focus:bg-white focus:border-blue-600"
              >
                {projects.length === 0 ? (
                  <option value="">No projects yet</option>
                ) : (
                  projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))
                )}
              </select>
            </div>

            <button
              type="button"
              onClick={() => handleNavigate('import')}
              className="min-h-[38px] px-3.5 py-1.5 rounded-lg bg-blue-700 hover:bg-blue-800 text-white text-xs font-medium inline-flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0"
            >
              <Plus className="w-3.5 h-3.5" aria-hidden="true" />
              <span>New Project</span>
            </button>
          </div>
        </header>

        {/* Main Scrollable Viewport */}
        <main className="flex-1 w-full max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 pb-24 lg:pb-10">
          {children}
        </main>
      </div>

      {/* Mobile Bottom Thumb Navigation (56px height; total mobile sticky = 108px < 15% of 844px) */}
      <nav
        aria-label="Mobile quick navigation"
        className="lg:hidden fixed bottom-0 left-0 right-0 z-30 h-14 bg-white/95 backdrop-blur border-t border-slate-200 grid grid-cols-5"
      >
        {MOBILE_BOTTOM_TABS.map((id) => {
          const item = NAV_ITEMS.find((n) => n.id === id)!;
          const Icon = item.icon;
          const isActive = activeScreen === id;
          return (
            <button
              key={id}
              type="button"
              onClick={() => handleNavigate(id)}
              aria-current={isActive ? 'page' : undefined}
              className={`min-h-[44px] flex flex-col items-center justify-center gap-0.5 text-[11px] font-medium transition-colors ${
                isActive ? 'text-blue-700' : 'text-slate-600'
              }`}
            >
              <Icon className="w-4 h-4" aria-hidden="true" />
              <span className="truncate">{item.shortLabel}</span>
            </button>
          );
        })}
        <button
          type="button"
          onClick={() => setDrawerOpen(true)}
          className="min-h-[44px] flex flex-col items-center justify-center gap-0.5 text-[11px] font-medium text-slate-600"
        >
          <Menu className="w-4 h-4" aria-hidden="true" />
          <span>More</span>
        </button>
      </nav>

      {/* Mobile Full Screen Navigation Drawer */}
      {drawerOpen ? (
        <div
          className="lg:hidden fixed inset-0 z-50 bg-slate-900/40 backdrop-blur-[1px] flex justify-end"
          role="dialog"
          aria-modal="true"
          aria-label="Studio navigation menu"
        >
          <div className="w-80 max-w-[88vw] bg-white h-full flex flex-col border-l border-slate-200">
            <div className="h-14 px-4 flex items-center justify-between border-b border-slate-200">
              <span className="text-sm font-semibold text-slate-900">
                All Studio Screens (12)
              </span>
              <button
                type="button"
                onClick={() => setDrawerOpen(false)}
                aria-label="Close navigation menu"
                className="min-h-[44px] min-w-[44px] flex items-center justify-center text-slate-600 hover:text-slate-900 rounded-lg"
              >
                <X className="w-5 h-5" aria-hidden="true" />
              </button>
            </div>

            {projects.length > 0 ? (
              <div className="p-4 border-b border-slate-200 bg-slate-50">
                <label
                  htmlFor="mobile-active-project-select"
                  className="block text-xs font-medium text-slate-600 mb-1.5"
                >
                  Active Project
                </label>
                <select
                  id="mobile-active-project-select"
                  value={activeProjectId ?? ''}
                  onChange={(e) => void setActiveProjectId(e.target.value || null)}
                  className="w-full h-11 rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900"
                >
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}

            <nav className="flex-1 overflow-y-auto p-3 space-y-4">
              {groups.map((groupName) => (
                <div key={groupName}>
                  <p className="px-3 mb-1 text-[11px] font-medium text-slate-400">
                    {groupName}
                  </p>
                  <ul className="space-y-0.5">
                    {NAV_ITEMS.filter((i) => i.group === groupName).map((item) => {
                      const Icon = item.icon;
                      const isActive = item.id === activeScreen;
                      return (
                        <li key={item.id}>
                          <button
                            type="button"
                            onClick={() => handleNavigate(item.id)}
                            className={`w-full min-h-[44px] px-3 py-2 rounded-lg flex items-center gap-3 text-sm font-medium ${
                              isActive
                                ? 'bg-blue-50 text-blue-800'
                                : 'text-slate-700 hover:bg-slate-100'
                            }`}
                          >
                            <Icon className="w-4 h-4 shrink-0" aria-hidden="true" />
                            <span>{item.label}</span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))}
            </nav>
          </div>
        </div>
      ) : null}
    </div>
  );
}
