import React from 'react';
import { StudioProvider, useStudio } from './state/StudioContext';
import { AppShell } from './components/AppShell';
import { NoticeBanner } from './components/StudioPrimitives';
import { HomeDashboardScreen } from './screens/HomeDashboardScreen';
import { ProjectsScreen } from './screens/ProjectsScreen';
import { MediaImportScreen } from './screens/MediaImportScreen';
import { MediaAnalysisScreen } from './screens/MediaAnalysisScreen';
import { CharacterStudioScreen } from './screens/CharacterStudioScreen';
import { VoiceLibraryScreen } from './screens/VoiceLibraryScreen';
import { TranslationStudioScreen } from './screens/TranslationStudioScreen';
import { ProcessingCenterScreen } from './screens/ProcessingCenterScreen';
import { AudioStudioScreen } from './screens/AudioStudioScreen';
import { QualityAssuranceScreen } from './screens/QualityAssuranceScreen';
import { ModelManagerScreen } from './screens/ModelManagerScreen';
import { SettingsStorageScreen } from './screens/SettingsStorageScreen';

function StudioRouter() {
  const { ready, loadError, activeScreen } = useStudio();

  if (!ready) {
    return (
      <div className="min-h-screen bg-[#F7F8FA] flex items-center justify-center p-6">
        <div className="bg-white border border-slate-200 rounded-xl p-6 max-w-sm w-full text-center">
          <p className="text-sm font-semibold text-slate-900">Initializing Local Studio Database…</p>
          <p className="mt-1 text-xs text-slate-500">
            Opening IndexedDB schema (25 structured stores + isolated media vault).
          </p>
        </div>
      </div>
    );
  }

  const renderScreen = () => {
    switch (activeScreen) {
      case 'home':
        return <HomeDashboardScreen />;
      case 'projects':
        return <ProjectsScreen />;
      case 'import':
        return <MediaImportScreen />;
      case 'analysis':
        return <MediaAnalysisScreen />;
      case 'characters':
        return <CharacterStudioScreen />;
      case 'voices':
        return <VoiceLibraryScreen />;
      case 'translation':
        return <TranslationStudioScreen />;
      case 'processing':
        return <ProcessingCenterScreen />;
      case 'audio_studio':
        return <AudioStudioScreen />;
      case 'qa':
        return <QualityAssuranceScreen />;
      case 'models':
        return <ModelManagerScreen />;
      case 'settings':
        return <SettingsStorageScreen />;
      default:
        return <HomeDashboardScreen />;
    }
  };

  return (
    <AppShell>
      {loadError ? (
        <div className="mb-6">
          <NoticeBanner
            tone="error"
            title="Local Storage Initialization Warning"
            description={loadError}
          />
        </div>
      ) : null}
      {renderScreen()}
    </AppShell>
  );
}

export default function App() {
  return (
    <StudioProvider>
      <StudioRouter />
    </StudioProvider>
  );
}
