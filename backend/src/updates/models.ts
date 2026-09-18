import { check } from "@/updates/check";
import type { UpdateFetcher } from "@/updates/check";
export async function watchModels(fetcher: UpdateFetcher = fetch) { return check("models", fetcher); }
