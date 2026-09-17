// Registers a real DOM (happy-dom) for `bun test`, the same shape
// backend/tests/preload.ts uses for its own test-only setup. Needed for
// @testing-library/react component tests (kit/settings/SettingField.test.tsx):
// bun's default test environment has no `document`/`window` at all.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// happy-dom's own ReadableStream/WritableStream/TransformStream are
// incomplete (no real `getReader()`-backed piping) - fine for
// @testing-library/react's DOM needs, but a real streaming library
// (assistant-stream, step 4's chatThreadListAdapter.ts) built against
// the actual web-streams spec breaks the moment GlobalRegistrator
// replaces these globals with happy-dom's versions. Captured before
// registration and restored right after: Bun's own native
// implementations, not happy-dom's, for every test in the suite.
const nativeStreams = {
  ReadableStream: globalThis.ReadableStream,
  WritableStream: globalThis.WritableStream,
  TransformStream: globalThis.TransformStream,
};

GlobalRegistrator.register();
Object.assign(globalThis, nativeStreams);
