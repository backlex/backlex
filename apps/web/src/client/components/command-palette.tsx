import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  LogOutIcon,
  MoonIcon,
  PlusIcon,
  RefreshCwIcon,
  SunIcon,
} from "lucide-react";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@workeros/ui/components/command";
import { auth } from "@/lib/auth";
import { NAV_ITEMS } from "@/lib/nav";
import { useTheme } from "@/components/theme-provider";
import { api } from "@/lib/api";

interface Collection {
  slug: string;
}

/**
 * Global cmd+k / ctrl+k command palette. Surfaces:
 *   - Navigation entries from NAV_ITEMS
 *   - Live list of collections (jump straight to /collections/<slug>)
 *   - Quick actions (sign out, toggle theme, refresh)
 */
export const CommandPalette = () => {
  const [open, setOpen] = useState(false);
  const [collections, setCollections] = useState<Collection[]>([]);
  const navigate = useNavigate();
  const { theme, setTheme } = useTheme();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((s) => !s);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Fetch collections lazily — first time the palette opens.
  useEffect(() => {
    if (!open || collections.length > 0) return;
    api<{ data: Collection[] }>("/api/collections")
      .then((r) => setCollections(r.data))
      .catch(() => {
        // Swallow — palette still useful for nav/actions even without collection list.
      });
  }, [open, collections.length]);

  const go = (path: string) => {
    setOpen(false);
    navigate(path);
  };

  const signOut = async () => {
    setOpen(false);
    await auth.signOut().catch(() => undefined);
    navigate("/sign-in");
  };

  const cycleTheme = () => {
    setOpen(false);
    setTheme(theme === "dark" ? "light" : theme === "light" ? "system" : "dark");
  };

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput placeholder="Type a command, page, or collection…" />
      <CommandList>
        <CommandEmpty>No results.</CommandEmpty>

        <CommandGroup heading="Navigation">
          {NAV_ITEMS.map((item) => (
            <CommandItem
              key={item.url}
              keywords={item.keywords ?? []}
              onSelect={() => go(item.url)}
            >
              <item.icon />
              {item.title}
            </CommandItem>
          ))}
        </CommandGroup>

        {collections.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Collections">
              {collections.map((c) => (
                <CommandItem
                  key={c.slug}
                  value={`collection:${c.slug}`}
                  keywords={[c.slug]}
                  onSelect={() => go(`/collections/${c.slug}`)}
                >
                  <span className="font-mono text-sm">{c.slug}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}

        <CommandSeparator />
        <CommandGroup heading="Actions">
          <CommandItem
            keywords={["new", "create"]}
            onSelect={() => go("/collections")}
          >
            <PlusIcon />
            New collection
            <CommandShortcut>↵</CommandShortcut>
          </CommandItem>
          <CommandItem
            keywords={["dark", "light"]}
            onSelect={cycleTheme}
          >
            {theme === "dark" ? <SunIcon /> : <MoonIcon />}
            Toggle theme ({theme})
            <CommandShortcut>D</CommandShortcut>
          </CommandItem>
          <CommandItem
            keywords={["reload"]}
            onSelect={() => {
              setOpen(false);
              window.location.reload();
            }}
          >
            <RefreshCwIcon />
            Reload page
          </CommandItem>
          <CommandItem keywords={["log out", "logout"]} onSelect={signOut}>
            <LogOutIcon />
            Sign out
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
};
