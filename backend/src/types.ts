import type { RoleId } from "@/roles";

export interface ClientRecord {
  id: string;
  name: string;
  keyPrefix: string;
  allowedRoles: RoleId[];
  createdAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
  requests: number;
  tokensIn: number;
  tokensOut: number;
  audioSeconds: number;
  jobs: number;
}

export type AppEnv = {
  Variables: {
    client?: ClientRecord;
  };
};
