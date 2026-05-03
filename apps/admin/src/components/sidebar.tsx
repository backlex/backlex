import { NavLink } from "react-router-dom";
import { Database, FolderTree, HardDrive, Sparkles, Radio } from "lucide-react";
import { cn } from "@/lib/utils";

const items = [
  { to: "/", label: "Dashboard", icon: Database },
  { to: "/collections", label: "Collections", icon: FolderTree },
  { to: "/storage", label: "Storage", icon: HardDrive },
  { to: "/vector", label: "Vector", icon: Sparkles },
  { to: "/realtime", label: "Realtime", icon: Radio },
];

export const Sidebar = () => (
  <aside className="w-60 shrink-0 border-r bg-card">
    <div className="flex h-14 items-center border-b px-4 font-semibold">workeros</div>
    <nav className="flex flex-col gap-1 p-2">
      {items.map(({ to, label, icon: Icon }) => (
        <NavLink
          key={to}
          to={to}
          end={to === "/"}
          className={({ isActive }) =>
            cn(
              "flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors hover:bg-accent",
              isActive && "bg-accent text-accent-foreground",
            )
          }
        >
          <Icon className="size-4" />
          {label}
        </NavLink>
      ))}
    </nav>
  </aside>
);
