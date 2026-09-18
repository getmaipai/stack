import { expect, test } from "bun:test";
import { notificationsFor } from "@/desktopModel";
const on = { model: true, update: true, check: true, health: true, runState: false };
test("notifications keep durable events and action targets", () => { expect(notificationsFor([{ id: "job.progress", durable: false }, { id: "model.installed", durable: true, data: { modelId: "qwen" } }, { id: "update.available", durable: true }], on)).toEqual([{ title: "A model finished installing", target: "/models/qwen" }, { title: "A Stack update is ready", target: "/settings/updates" }]); });
test("preferences gate notification kinds", () => { expect(notificationsFor([{ id: "health.changed", durable: true }], { ...on, health: false })).toEqual([]); });
