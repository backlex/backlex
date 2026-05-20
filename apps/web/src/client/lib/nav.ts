import {
  ActivityIcon,
  DatabaseIcon,
  FolderTreeIcon,
  HardDriveIcon,
  KeyRoundIcon,
  RadioIcon,
  Settings2Icon,
  SparklesIcon,
  WebhookIcon,
  WorkflowIcon,
  ZapIcon,
  type LucideIcon,
} from "lucide-react";

export interface NavItem {
  title: string;
  url: string;
  icon: LucideIcon;
  /** Helps the cmd-k palette match alternate names (e.g. "files" → Storage). */
  keywords?: string[];
}

export const NAV_ITEMS: NavItem[] = [
  { title: "Dashboard", url: "/", icon: DatabaseIcon, keywords: ["home"] },
  { title: "Collections", url: "/collections", icon: FolderTreeIcon, keywords: ["tables", "schemas"] },
  { title: "Storage", url: "/storage", icon: HardDriveIcon, keywords: ["files", "uploads", "r2", "s3"] },
  { title: "Vector", url: "/vector", icon: SparklesIcon, keywords: ["embeddings", "search"] },
  { title: "Realtime", url: "/realtime", icon: RadioIcon, keywords: ["sse", "websocket", "channels"] },
  { title: "Logs", url: "/logs", icon: ActivityIcon, keywords: ["activity", "log", "history", "audit", "stream"] },
  { title: "Webhooks", url: "/webhooks", icon: WebhookIcon, keywords: ["http", "events"] },
  { title: "Flows", url: "/flows", icon: WorkflowIcon, keywords: ["automation", "triggers"] },
  { title: "Functions", url: "/functions", icon: ZapIcon, keywords: ["serverless", "code", "sandbox"] },
  { title: "API Keys", url: "/api-keys", icon: KeyRoundIcon, keywords: ["pak", "tokens", "auth"] },
  { title: "Settings", url: "/settings", icon: Settings2Icon, keywords: ["roles", "users", "passkeys"] },
];
