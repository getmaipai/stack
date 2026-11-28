interface AudioTag { label: string; score: number; }

export const SOUND_EVENT_CLASSES = [
  { class: "smoke_alarm", labels: ["Smoke detector, smoke alarm", "Fire alarm"], threshold: 0.5 },
  { class: "siren", labels: ["Siren", "Civil defense siren"], threshold: 0.5 },
  { class: "glass_breaking", labels: ["Shatter", "Glass"], threshold: 0.5 },
  { class: "doorbell", labels: ["Doorbell"], threshold: 0.5 },
  { class: "door_knock", labels: ["Knock"], threshold: 0.5 },
  { class: "dog_barking", labels: ["Bark"], threshold: 0.5 },
  { class: "cat", labels: ["Meow"], threshold: 0.5 },
  { class: "baby_crying", labels: ["Baby cry, infant cry"], threshold: 0.5 },
  { class: "shouting", labels: ["Shout", "Yell"], threshold: 0.5 },
  { class: "water_running", labels: ["Water tap, faucet"], threshold: 0.5 },
  { class: "appliance_beep", labels: ["Beep, bleep"], threshold: 0.5 },
  { class: "music_tv", labels: ["Music", "Television"], threshold: 0.5 },
] as const;

export type SoundEventClass = (typeof SOUND_EVENT_CLASSES)[number]["class"];
export interface SoundEvent { class: SoundEventClass; score: number; }

export function mapTagsToEvents(tags: AudioTag[]): SoundEvent[] {
  const best = new Map<SoundEventClass, number>();
  for (const tag of tags) {
    const entry = SOUND_EVENT_CLASSES.find((candidate) => (candidate.labels as readonly string[]).includes(tag.label));
    if (!entry || tag.score < entry.threshold) continue;
    const previous = best.get(entry.class) ?? -Infinity;
    if (tag.score > previous) best.set(entry.class, tag.score);
  }
  return [...best].map(([eventClass, score]) => ({ class: eventClass, score })).sort((a, b) => b.score - a.score);
}
