import { issueClient } from "@/lib/clients";
import { ROLE_IDS } from "@/roles";

const testClientKey = issueClient("test-suite", [...ROLE_IDS]);

export const testClientHeaders = {
  authorization: `Bearer ${testClientKey}`,
};
