import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { MoonIcon, SearchIcon, SunIcon } from "lucide-react";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
} from "@workeros/ui/components/breadcrumb";
import { Separator } from "@workeros/ui/components/separator";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@workeros/ui/components/sidebar";
import { AppSidebar } from "@/components/app-sidebar";
import { useTheme } from "@/components/theme-provider";
import { auth } from "@/lib/auth";

const titleFor = (pathname: string) => {
  if (pathname === "/") return "Dashboard";
  const seg = pathname.split("/").filter(Boolean)[0] ?? "";
  return seg.charAt(0).toUpperCase() + seg.slice(1);
};

const initialsFromEmail = (email: string | undefined): string => {
  if (!email) return "?";
  const local = email.split("@")[0] ?? "";
  return (local.slice(0, 2).toUpperCase() || "?").padEnd(2, "·");
};

const openPalette = () => {
  // The CommandPalette listens for cmd/ctrl+k — fire it programmatically.
  window.dispatchEvent(
    new KeyboardEvent("keydown", { key: "k", metaKey: true }),
  );
};

interface UserSummary {
  email?: string;
  name?: string | null;
}

export const AppLayout = ({ children }: { children: ReactNode }) => {
  const { pathname } = useLocation();
  const { theme, setTheme } = useTheme();
  const dark = theme === "dark";
  const [user, setUser] = useState<UserSummary | null>(null);

  // Pull the current user once for the avatar — best-effort.
  useEffect(() => {
    let cancelled = false;
    auth
      .getSession()
      .then((res) => {
        if (cancelled) return;
        const u =
          (res as { data?: { user?: UserSummary } })?.data?.user ?? null;
        setUser(u);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const isMac =
    typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
  const kbdSymbol = isMac ? "⌘" : "Ctrl ";

  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset>
        <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border bg-background px-3 sm:px-4">
          <SidebarTrigger className="-ml-1 shrink-0" />
          <Separator
            orientation="vertical"
            className="mr-1 hidden h-4 sm:block"
          />
          <Breadcrumb className="min-w-0 flex-1 sm:flex-initial">
            <BreadcrumbList>
              <BreadcrumbItem>
                <BreadcrumbPage className="truncate">
                  {titleFor(pathname)}
                </BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>

          {/* Center kbar — opens the cmd+k palette. Collapses to an icon
              button on narrow viewports so the breadcrumb + actions fit. */}
          <button
            type="button"
            onClick={openPalette}
            className="ml-auto hidden h-8 cursor-pointer items-center gap-2 rounded-3xl border border-border bg-card px-3 pl-3.5 pr-2 text-sm text-muted-foreground transition-colors hover:bg-accent md:inline-flex md:w-[240px] md:flex-shrink lg:w-[300px] xl:w-[360px]"
            aria-label="Open command palette"
          >
            <SearchIcon className="size-3.5 shrink-0" />
            <span className="min-w-0 flex-1 truncate text-left">
              Search collections, items, settings…
            </span>
            <span className="shrink-0 rounded-md border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
              {kbdSymbol}K
            </span>
          </button>

          <button
            type="button"
            onClick={openPalette}
            className="ml-auto grid size-8 shrink-0 place-items-center rounded-3xl border border-border bg-card text-foreground transition-colors hover:bg-accent md:hidden"
            aria-label="Open command palette"
            title="Search (⌘K)"
          >
            <SearchIcon size={14} />
          </button>

          <button
            type="button"
            onClick={() => setTheme(dark ? "light" : "dark")}
            className="grid size-8 shrink-0 place-items-center rounded-3xl border border-border bg-card text-foreground transition-colors hover:bg-accent"
            aria-label="Toggle theme"
            title="Toggle theme (d)"
          >
            {dark ? <SunIcon size={14} /> : <MoonIcon size={14} />}
          </button>

          <div
            className="grid size-8 shrink-0 place-items-center rounded-full bg-gradient-to-br from-[oklch(0.78_0.18_130)] to-[oklch(0.55_0.18_145)] text-[12.5px] font-semibold text-[oklch(0.18_0.05_130)]"
            title={user?.email ?? "signed in"}
          >
            {initialsFromEmail(user?.email)}
          </div>
        </header>
        <div className="flex flex-1 flex-col gap-4 p-4">{children}</div>
      </SidebarInset>
    </SidebarProvider>
  );
};
