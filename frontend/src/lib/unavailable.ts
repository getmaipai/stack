export interface UnavailableControl {
  id: string;
  label: string;
  sentence: string;
  page: string;
}

export const unavailableControls: UnavailableControl[] = [
  { id: "engine-install-unqualified", label: "Install", sentence: "This engine has no tested install for this computer yet.", page: "engines" },
  { id: "engine-update", label: "Update", sentence: "Engine updates need a tested build and recovery check before they can run here.", page: "engines" },
  { id: "detected-remove", label: "Remove", sentence: "This tool belongs to another app; Stack can only forget its listing.", page: "engines" },
  { id: "detected-start", label: "Start", sentence: "This tool runs outside Stack; manage it in its own app.", page: "engines" },
  { id: "detected-stop", label: "Stop", sentence: "This tool runs outside Stack; manage it in its own app.", page: "engines" },
  { id: "detected-restart", label: "Restart", sentence: "This tool runs outside Stack; manage it in its own app.", page: "engines" },
  { id: "detected-configure", label: "Configure", sentence: "This tool runs outside Stack; manage it in its own app.", page: "engines" },
  { id: "model-install-unresolved", label: "Install", sentence: "This model needs verified files, licence and a tested way to run before installation.", page: "models" },
  { id: "model-update-gated", label: "Update", sentence: "This model needs verified files, licence and a tested way to run before installation.", page: "models" },
  { id: "model-load-unqualified", label: "Load", sentence: "There is no tested engine for this model here yet.", page: "models" },
  { id: "model-unload-unqualified", label: "Unload", sentence: "There is no tested engine for this model here yet.", page: "models" },
  { id: "model-pin-unqualified", label: "Pin", sentence: "There is no tested engine for this model here yet.", page: "models" },
  { id: "tester-voice-record", label: "Record", sentence: "Voice needs a tested local speech engine before this can run.", page: "tester" },
  { id: "tester-voice-play", label: "Play", sentence: "Voice needs a tested local speech engine before this can run.", page: "tester" },
  { id: "tester-image-generate", label: "Generate", sentence: "This role needs a tested generation job; no result will be produced yet.", page: "tester" },
  { id: "tester-video-generate", label: "Generate", sentence: "This role needs a tested generation job; no result will be produced yet.", page: "tester" },
  { id: "tester-music-generate", label: "Generate", sentence: "This role needs a tested generation job; no result will be produced yet.", page: "tester" },
  { id: "settings-clear-caches", label: "Clear caches", sentence: "Cache clearing is not available yet; installed models stay intact.", page: "settings" },
  { id: "phone-add", label: "Add", sentence: "Open the full page to use this action until phone controls are ready.", page: "phone" },
  { id: "phone-search", label: "Search", sentence: "Open the full page to use this action until phone controls are ready.", page: "phone" },
  { id: "phone-group", label: "Group", sentence: "Open the full page to use this action until phone controls are ready.", page: "phone" },
  { id: "current-manifest-missing", label: "Current", sentence: "Update status is unknown; the last verified check is shown below.", page: "app" },
  { id: "ask-repair", label: "Ask repair", sentence: "I can show matching Help and status, but I cannot verify that repair.", page: "help" },
];

export function sentenceFor(id: string): string | undefined {
  return unavailableControls.find((control) => control.id === id)?.sentence;
}
