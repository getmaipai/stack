import { check } from "@/updates/check";
import type { UpdateFetcher } from "@/updates/check";
export async function checkApp(fetcher: UpdateFetcher = fetch) { return check("app", fetcher); }
