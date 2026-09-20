// The one declaration of the console's information architecture.
// Source: docs/plans/ui-spec-2026-09-19/spec.md, sections 2 and 4.
import type { IconName } from "@/kit/icons";

export type TaxonomyDestination = {
  id: string;
  label: string;
  path: string;
  subtitle: string;
  icon: IconName;
  hue?: string;
  subtypes?: string[];
};

export type TaxonomyGroup = {
  id: string;
  label: string;
  destinations: TaxonomyDestination[];
};

export type TaxonomyCategory = {
  id: string;
  label: string;
  icon: IconName;
  hue: string;
};

export const groups: TaxonomyGroup[] = [
  {
    id: "stack",
    label: "STACK",
    destinations: [
      { id: "overview", label: "Overview", path: "/", subtitle: "All systems, components, and resources at a glance.", icon: "LayoutDashboard" },
      { id: "models", label: "Models", path: "/models", subtitle: "Manage, install, and run AI models", icon: "Box", hue: "--cat-models", subtypes: ["LLMs", "Image", "Video", "Audio", "Embeddings"] },
      { id: "adapters", label: "Adapters", path: "/adapters", subtitle: "LoRAs, ControlNets, and other model adapters.", icon: "Puzzle", hue: "--cat-adapters", subtypes: ["LoRAs", "ControlNets", "VAEs"] },
      { id: "apps", label: "Apps", path: "/apps", subtitle: "Chat, image, coding, and agent apps built on your models.", icon: "LayoutGrid", hue: "--cat-apps", subtypes: ["Chat", "Image", "Coding", "Agents", "Knowledge"] },
      { id: "runtimes", label: "Runtimes", path: "/runtimes", subtitle: "The engines that run your models.", icon: "Cpu", hue: "--cat-runtimes", subtypes: ["Ollama", "llama.cpp", "vLLM", "Diffusers"] },
      { id: "workflows", label: "Workflows", path: "/workflows", subtitle: "Multi-step pipelines like ComfyUI, n8n, and Langflow.", icon: "Workflow", hue: "--cat-workflows", subtypes: ["ComfyUI workflows", "n8n", "Langflow"] },
      { id: "extensions", label: "Extensions", path: "/extensions", subtitle: "Plugins, MCP servers, and integrations.", icon: "Plug", hue: "--cat-extensions", subtypes: ["Plugins", "MCP Servers", "Integrations"] },
      { id: "training", label: "Training", path: "/training", subtitle: "Train and fine-tune your own models.", icon: "GraduationCap", hue: "--cat-training", subtypes: ["Trainers", "Fine-tuning", "Datasets"] },
    ],
  },
  {
    id: "system",
    label: "System",
    destinations: [
      { id: "system", label: "System / Drivers", path: "/system", subtitle: "Drivers, accelerators, and dependencies this computer needs.", icon: "CircuitBoard", hue: "--cat-system", subtypes: ["Drivers", "Accelerators", "Dependencies"] },
      { id: "clients", label: "Clients", path: "/clients", subtitle: "The apps and devices connected to this Stack.", icon: "Users" },
      { id: "monitoring", label: "Monitoring", path: "/monitoring", subtitle: "Live resource use across CPU, memory, GPU, and storage.", icon: "Activity" },
      { id: "tester", label: "Tester", path: "/try", subtitle: "Try a model or prompt without leaving the Stack.", icon: "Play" },
    ],
  },
  {
    id: "resources",
    label: "Resources",
    destinations: [
      { id: "packages", label: "Packages", path: "/packages", subtitle: "Everything this Stack can install and update.", icon: "Package" },
      { id: "docs", label: "Docs", path: "/docs", subtitle: "Search the built-in help and your local library.", icon: "FileText" },
    ],
  },
  {
    id: "manage",
    label: "MANAGE",
    destinations: [
      { id: "settings", label: "Settings", path: "/settings", subtitle: "Configure how this Stack runs.", icon: "Settings" },
      { id: "logs", label: "Logs", path: "/logs", subtitle: "What this Stack has been doing.", icon: "History" },
      { id: "alerts", label: "Alerts", path: "/alerts", subtitle: "Issues that need your attention.", icon: "BellRing" },
    ],
  },
];

export const categories: TaxonomyCategory[] = [
  { id: "models", label: "Models", icon: "Box", hue: "--cat-models" },
  { id: "adapters", label: "Adapters", icon: "Puzzle", hue: "--cat-adapters" },
  { id: "apps", label: "Apps", icon: "LayoutGrid", hue: "--cat-apps" },
  { id: "runtimes", label: "Runtimes", icon: "Cpu", hue: "--cat-runtimes" },
  { id: "workflows", label: "Workflows", icon: "Workflow", hue: "--cat-workflows" },
  { id: "extensions", label: "Extensions", icon: "Plug", hue: "--cat-extensions" },
  { id: "training", label: "Training", icon: "GraduationCap", hue: "--cat-training" },
  { id: "system", label: "System", icon: "CircuitBoard", hue: "--cat-system" },
];

export function allDestinations(): TaxonomyDestination[] {
  return groups.flatMap((group) => group.destinations);
}
