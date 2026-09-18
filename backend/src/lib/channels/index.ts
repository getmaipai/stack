import { eq } from "drizzle-orm";
import { db } from "@/db";
import { channels } from "@/db/schema";
import { raise, resolve } from "@/lib/health";
import { decryptChannelConfig, encryptChannelConfig } from "@/lib/channels/crypto";
import { send, type ChannelConfig, type ChannelFetch } from "@/lib/channels/providers";

export type ChannelType = "telegram" | "ntfy";
export const CHANNEL_TYPES = ["telegram", "ntfy"] as const;
export type ChannelInput = { type: ChannelType; name: string; config: ChannelConfig };
export type ChannelRecord = typeof channels.$inferSelect;

function redact(text: string, config: ChannelConfig): string {
  const secrets = ["botToken" in config ? config.botToken : "", "accessToken" in config ? config.accessToken ?? "" : ""].filter(Boolean);
  return secrets.reduce((result, secret) => result.replaceAll(secret, "[redacted]"), text).slice(0, 500);
}

function status(row: ChannelRecord): "verified" | "unverified" | "failing" {
  if (row.pausedAt) return "failing";
  return row.verifiedAt ? "verified" : "unverified";
}

export function viewChannel(row: ChannelRecord): Record<string, unknown> {
  let publicConfig: Record<string, unknown> = {};
  try {
    const config = decryptChannelConfig<ChannelConfig>(row.config);
    if (row.type === "ntfy") {
      const ntfy = config as Extract<ChannelConfig, { serverUrl: string }>;
      publicConfig = { serverUrl: ntfy.serverUrl, topic: ntfy.topic };
    }
  } catch { /* An invalid encrypted value is reported by the next test. */ }
  return { id: row.id, type: row.type, name: row.name, ...publicConfig, verifiedAt: row.verifiedAt, createdAt: row.createdAt, lastError: row.lastError, lastSentAt: row.lastSentAt, status: status(row), configPresent: true };
}

export function listChannels(): Record<string, unknown>[] { return db.select().from(channels).all().map(viewChannel); }

export function createChannel(input: ChannelInput): Record<string, unknown> {
  const now = new Date().toISOString();
  const row = { id: `channel-${crypto.randomUUID()}`, type: input.type, name: input.name, config: encryptChannelConfig(input.config), verifiedAt: null, createdAt: now, lastError: null, lastSentAt: null, failureCount: 0, pausedAt: null };
  db.insert(channels).values(row).run();
  channelHealth(row);
  return viewChannel(row);
}

export function updateChannel(id: string, input: Partial<ChannelInput>): Record<string, unknown> | null {
  const existing = db.select().from(channels).where(eq(channels.id, id)).get();
  if (!existing) return null;
  const config = input.config ? encryptChannelConfig(input.config) : existing.config;
  db.update(channels).set({ ...(input.type ? { type: input.type } : {}), ...(input.name ? { name: input.name } : {}), config, verifiedAt: null, lastError: null, failureCount: 0, pausedAt: null }).where(eq(channels.id, id)).run();
  const row = db.select().from(channels).where(eq(channels.id, id)).get()!;
  channelHealth(row);
  return viewChannel(row);
}

export function removeChannel(id: string): boolean { const row = db.select({ id: channels.id }).from(channels).where(eq(channels.id, id)).get(); if (!row) return false; db.delete(channels).where(eq(channels.id, id)).run(); return true; }

function channelMessage(row: ChannelRecord, message: string): Promise<void> {
  const config = decryptChannelConfig<ChannelConfig>(row.config);
  return send({ type: row.type as ChannelType, config }, message);
}

function channelHealth(row: ChannelRecord): void {
  raise({ code: `channel-unverified.${row.id}`, severity: "warning", title: `${row.name} has not been verified`, text: "Send a test to verify this alert channel.", cause: "The channel has not received a successful test message.", fix: { label: "Send a test", action: `test_channel:${row.id}` } });
}

export async function testChannel(id: string, fetcher?: ChannelFetch): Promise<{ ok: true } | { ok: false; error: string }> {
  const row = db.select().from(channels).where(eq(channels.id, id)).get();
  if (!row) return { ok: false, error: "Unknown channel." };
  try {
    const config = decryptChannelConfig<ChannelConfig>(row.config);
    await send({ type: row.type as ChannelType, config }, "MaiPai Home test alert: this channel is ready.", fetcher);
    const now = new Date().toISOString();
    db.update(channels).set({ verifiedAt: now, lastSentAt: now, lastError: null, failureCount: 0, pausedAt: null }).where(eq(channels.id, id)).run();
    resolve(`channel-unverified.${id}`);
    resolve(`channel-failed.${id}`);
    return { ok: true };
  } catch (error) {
    const config = (() => { try { return decryptChannelConfig<ChannelConfig>(row.config); } catch { return {} as ChannelConfig; } })();
    const message = redact(error instanceof Error ? error.message : "The channel test failed.", config);
    db.update(channels).set({ lastError: message, failureCount: row.failureCount + 1, pausedAt: row.failureCount + 1 >= 3 ? new Date().toISOString() : row.pausedAt }).where(eq(channels.id, id)).run();
    channelHealth(row);
    return { ok: false, error: message };
  }
}

export async function notifyAlertChannels(message: string): Promise<void> {
  const verified = db.select().from(channels).all().filter((row) => row.verifiedAt && !row.pausedAt);
  await Promise.all(verified.map(async (row) => {
    try {
      await channelMessage(row, message);
      db.update(channels).set({ lastSentAt: new Date().toISOString(), lastError: null, failureCount: 0 }).where(eq(channels.id, row.id)).run();
    } catch (error) {
      let config: ChannelConfig = {} as ChannelConfig;
      try { config = decryptChannelConfig<ChannelConfig>(row.config); } catch { /* retain generic error */ }
      const failureCount = row.failureCount + 1;
      const pausedAt = failureCount >= 3 ? new Date().toISOString() : row.pausedAt;
      const detail = redact(error instanceof Error ? error.message : "The channel delivery failed.", config);
      db.update(channels).set({ lastError: detail, failureCount, pausedAt }).where(eq(channels.id, row.id)).run();
      if (pausedAt) raise({ code: `channel-failed.${row.id}`, severity: "warning", title: `${row.name} is paused`, text: "Three alert deliveries failed. Send a test after fixing the channel.", cause: detail, fix: { label: "Send a test", action: `test_channel:${row.id}` } });
    }
  }));
}

export function __resetChannelsForTests(): void { db.delete(channels).run(); }
