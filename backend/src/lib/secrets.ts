// The Stack's reversible-secret instance (a person's Hugging Face token
// for voice cloning, STACK-94c): AES-256-GCM from @maipai/core, keyed by
// a keystore outside the database under data/keys, or by
// STACK_SECRETS_KEY when an operator keeps the key elsewhere. The
// plaintext reaches exactly one place, the environment of the engine
// that needs it; the settings route redacts it (CLAUDE.md, Credentials).
import { join } from "node:path";
import { createKeystore } from "@maipai/core/src/keystore";
import { createSecrets } from "@maipai/core/src/secrets";
import { dataDir } from "@/lib/paths";

const secrets = createSecrets({
  keystore: createKeystore({ keysDir: join(dataDir, "keys"), appId: "maipai-stack" }),
  keyName: "secrets_key",
  envKeyVar: "STACK_SECRETS_KEY",
});

export const encryptSecret = secrets.encrypt;
export const decryptSecret = secrets.decrypt;
