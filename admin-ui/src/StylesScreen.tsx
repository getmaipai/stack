import { StackLorasPage } from "@maipai/ui/src/stack/StackLorasPage";
import type { AdminStackClient } from "./stackClient";

/**
 * Styles (LoRAs for pictures and video): the shared Styles page from `@maipai/ui`, the same component Home's Styles tab shows. The Stack admin
 * is the Stack's own admin session, so nothing is redacted and every control is on. The page writes its own title.
 */
export function StylesScreen({ client }: { client: AdminStackClient }) {
  return <StackLorasPage client={client} />;
}
