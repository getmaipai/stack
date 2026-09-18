export type TelegramConfig = { botToken: string; chatId: string };
export type NtfyConfig = { serverUrl: string; topic: string; accessToken?: string };
export type ChannelConfig = TelegramConfig | NtfyConfig;
export type ProviderChannel = { type: "telegram" | "ntfy"; config: ChannelConfig };
export type ChannelFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

function timeoutSignal(): AbortSignal {
  return AbortSignal.timeout(10_000);
}

function providerError(response: Response, type: string): Error {
  return new Error(`${type} returned HTTP ${response.status}.`);
}

export async function sendTelegram(config: TelegramConfig, message: string, fetcher: ChannelFetch = fetch): Promise<void> {
  const response = await fetcher(`https://api.telegram.org/bot${encodeURIComponent(config.botToken)}/sendMessage`, {
    method: "POST",
    signal: timeoutSignal(),
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: config.chatId, text: message }),
  });
  if (!response.ok) throw providerError(response, "Telegram");
}

export async function sendNtfy(config: NtfyConfig, message: string, fetcher: ChannelFetch = fetch): Promise<void> {
  const base = config.serverUrl.replace(/\/+$/, "");
  const response = await fetcher(`${base}/${encodeURIComponent(config.topic)}`, {
    method: "POST",
    signal: timeoutSignal(),
    headers: { "content-type": "text/plain; charset=utf-8", Title: "MaiPai Home alert", ...(config.accessToken ? { Authorization: `Bearer ${config.accessToken}` } : {}) },
    body: message,
  });
  if (!response.ok) throw providerError(response, "ntfy");
}

export async function send(channel: ProviderChannel, message: string, fetcher: ChannelFetch = fetch): Promise<void> {
  if (channel.type === "telegram") return sendTelegram(channel.config as TelegramConfig, message, fetcher);
  return sendNtfy(channel.config as NtfyConfig, message, fetcher);
}
