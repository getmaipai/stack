import { useMemo, useRef } from "react";
import { StackModelsPage } from "@maipai/ui/src/stack/StackModelsPage";
import type { StackExtraSection, StackNavTarget } from "@maipai/ui/src/stack/StackModelsPage";
import type { Snapshot } from "./live";
import { ProfilePlanner } from "./ProfilePlanner";
import type { Notify } from "./screens";
import { createStackClient } from "./stackClient";
import type { AdminStackClient } from "./stackClient";

/** The one client the screen and the command palette share, so both read `GET /stack/v1/choices` the same way. */
export function useStackClient(refresh: () => void): AdminStackClient {
  const latest = useRef(refresh);
  latest.current = refresh;
  return useMemo(() => createStackClient(() => latest.current()), []);
}

/**
 * Features, models and priority: the shared AI and models page from `@maipai/ui`, the same component Home renders. The admin page adds only
 * what Home does not have, as an extra section (what this computer's memory can hold). The Stack's tools keep their own screen.
 */
export function ModelsScreen({ client, snap, refresh, notify, go }: { client: AdminStackClient; snap: Snapshot; refresh: () => void; notify: Notify; go: (screen: "resources" | "updates" | "health") => void }) {
  const roles = snap.roles;
  const sections: StackExtraSection[] = useMemo(() => roles ? [{
    id: "fit", title: "Setup for this computer", description: "How much memory this computer has for AI and which ready-made setup fits it.",
    content: <ProfilePlanner roles={roles} refresh={refresh} notify={notify} changed={client.changed} />,
  }] : [], [roles, refresh, notify, client]);
  const onNavigate = (target: StackNavTarget) => go(target === "disk" ? "resources" : target);
  return <StackModelsPage client={client} extraSections={sections} onNavigate={onNavigate} />;
}
