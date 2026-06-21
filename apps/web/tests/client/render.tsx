/**
 * Shared render harness for the admin React components.
 *
 * Wraps the unit under test in the providers a real admin page expects — a
 * React Query client, a Lingui i18n context (empty catalog → components render
 * their source strings), and a MemoryRouter (so `<Link>` / route hooks work
 * without a browser history). Build new component tests on `renderWithProviders`
 * so they don't each re-assemble the provider stack.
 */
import type { ReactElement, ReactNode } from "react";
import { render, type RenderResult } from "@testing-library/react";
import { setupI18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

// One i18n instance for the suite; empty messages means `t` returns the source
// string verbatim, which is what assertions match against.
const i18n = setupI18n({ locale: "en", messages: { en: {} } });

export const renderWithProviders = (
  ui: ReactElement,
  opts: { route?: string } = {},
): RenderResult => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <I18nProvider i18n={i18n}>
        <MemoryRouter initialEntries={[opts.route ?? "/"]}>
          {children}
        </MemoryRouter>
      </I18nProvider>
    </QueryClientProvider>
  );
  return render(ui, { wrapper: Wrapper });
};
