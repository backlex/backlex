// Integrations page — connect Slack/Discord/Datadog/GitHub; data events fan out
// to them via the shared @backlex/integrations adapters. Secrets are encrypted
// at rest and shown masked. UI mirrors the cloud control plane: brand-marked
// cards with a last-event timestamp, and a connect dialog that also lets the
// admin scope which collection events the integration receives.
import type { PushToast } from "../../types";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { Badge, Button, PageHeader, relativeTime } from "../../ui";
import { useCollections } from "../../queries";
import { api } from "@/lib/api";
import { Input } from "@backlex/ui/components/input";
import { Select } from "../../select";
import { Skeleton } from "@backlex/ui/components/skeleton";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@backlex/ui/components/dialog";
import type { DestinationColumn } from "@backlex/integrations/provider";
import { fetchSafely } from "../_shared";
import {
  IntegrationSyncsCard,
  type ChildGroup,
  type SettingField,
  type WebhookInfo,
} from "./integration-syncs-card";

type Field = {
  key: string;
  label: string;
  placeholder?: string;
  secret?: boolean;
  /** Present when the field is a choice; the UI renders a picker, not a box. */
  options?: { value: string; label: string }[];
};
type Provider = {
  id: string;
  label: string;
  category: string;
  capabilities: string[];
  oauth: boolean;
  /** This provider receives row CONTENTS, not just the fact of a change. */
  recordPayload?: boolean;
};
type Catalog = {
  kinds: string[];
  fields: Record<string, Field[]>;
  providers?: Provider[];
  /** The exact URI to register with each OAuth provider, derived server-side. */
  oauthRedirectUri?: string;
  /** Per-sync settings each source provider asks for, keyed by kind. */
  sourceSettings?: Record<string, SettingField[]>;
  /** Same, for providers that receive rows rather than supply them. */
  destinationSettings?: Record<string, SettingField[]>;
  /** Mapping targets for destinations with a closed column set. A kind that is
   *  absent takes any column name (a warehouse's columns are its own DDL).
   *  The FULL list — a column carrying `when` only applies under some settings,
   *  and the sync dialog narrows it as the operator chooses them. */
  destinationColumns?: Record<string, DestinationColumn[]>;
  /** Child groups a source returns beneath each record — an order's lines.
   *  A kind that is absent returns flat records and has none. */
  sourceChildGroups?: Record<string, ChildGroup[]>;
  /** How each provider that CALLS US authenticates, what it sends, and whether
   *  we can register the endpoint ourselves. Absent = sends no webhooks. */
  webhooks?: Record<string, WebhookInfo>;
};

/** Config key holding the OAuth access token. Present (masked) once authorized,
 *  which is how the card tells "credentials saved" from "account connected". */
const OAUTH_TOKEN_KEY = "_oauthAccessToken";
type Integration = {
  id: string;
  kind: string;
  status: string;
  config: Record<string, unknown>;
  events: string[] | null;
  lastEventAt?: number | string | null;
  consecutiveFailures?: number;
  lastFailureAt?: number | string | null;
  disabledReason?: string | null;
};
type Delivery = {
  id: string;
  event: string;
  status: number;
  ms: number;
  error: string | null;
  attempts: number;
  deliveredAt: number | string;
};

const GithubMark = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <path d="M12 .3a12 12 0 0 0-3.8 23.4c.6.1.8-.3.8-.6v-2c-3.3.7-4-1.6-4-1.6-.6-1.4-1.4-1.8-1.4-1.8-1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1.1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.8-1.6-2.7-.3-5.5-1.3-5.5-6 0-1.2.5-2.3 1.3-3.1-.2-.4-.6-1.6.1-3.2 0 0 1-.3 3.3 1.2a11.5 11.5 0 0 1 6 0c2.3-1.5 3.3-1.2 3.3-1.2.6 1.6.2 2.8.1 3.2.8.8 1.3 1.9 1.3 3.1 0 4.6-2.8 5.6-5.5 5.9.4.4.8 1.1.8 2.2v3.3c0 .3.2.7.8.6A12 12 0 0 0 12 .3" />
  </svg>
);

/** Official brand glyphs (simple-icons single-path SVGs), rendered white-on-brand. */
const ICONS: Record<string, string> = {
  slack: "M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zM18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zM15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z",
  discord: "M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z",
  teams: "M20.625 8.127q-.55 0-1.025-.205-.475-.205-.832-.563-.358-.357-.563-.832Q18 6.053 18 5.502q0-.54.205-1.02t.563-.837q.357-.358.832-.563.474-.205 1.025-.205.54 0 1.02.205t.837.563q.358.357.563.837.205.48.205 1.02 0 .55-.205 1.025-.205.475-.563.832-.357.358-.837.563-.48.205-1.02.205zm0-3.75q-.469 0-.797.328-.328.328-.328.797 0 .469.328.797.328.328.797.328.469 0 .797-.328.328-.328.328-.797 0-.469-.328-.797-.328-.328-.797-.328zM24 10.002v5.578q0 .774-.293 1.46-.293.685-.803 1.194-.51.51-1.195.803-.686.293-1.459.293-.445 0-.908-.105-.463-.106-.85-.329-.293.95-.855 1.729-.563.78-1.319 1.336-.756.557-1.67.861-.914.305-1.898.305-1.148 0-2.162-.398-1.014-.399-1.805-1.102-.79-.703-1.312-1.664t-.674-2.086h-5.8q-.411 0-.704-.293T0 16.881V6.873q0-.41.293-.703t.703-.293h8.59q-.34-.715-.34-1.5 0-.727.275-1.365.276-.639.75-1.114.475-.474 1.114-.75.638-.275 1.365-.275t1.365.275q.639.276 1.114.75.474.475.75 1.114.275.638.275 1.365t-.275 1.365q-.276.639-.75 1.113-.475.475-1.114.75-.638.276-1.365.276-.188 0-.375-.024-.188-.023-.375-.058v1.078h10.875q.469 0 .797.328.328.328.328.797zM12.75 2.373q-.41 0-.78.158-.368.158-.638.434-.27.275-.428.639-.158.363-.158.773 0 .41.158.78.159.368.428.638.27.27.639.428.369.158.779.158.41 0 .773-.158.364-.159.64-.428.274-.27.433-.639.158-.369.158-.779 0-.41-.158-.773-.159-.364-.434-.64-.275-.275-.639-.433-.363-.158-.773-.158zM6.937 9.814h2.25V7.94H2.814v1.875h2.25v6h1.875zm10.313 7.313v-6.75H12v6.504q0 .41-.293.703t-.703.293H8.309q.152.809.556 1.5.405.691.985 1.19.58.497 1.318.779.738.281 1.582.281.926 0 1.746-.352.82-.351 1.436-.966.615-.616.966-1.43.352-.815.352-1.752zm5.25-1.547v-5.203h-3.75v6.855q.305.305.691.452.387.146.809.146.469 0 .879-.176.41-.175.715-.48.304-.305.48-.715t.176-.879Z",
  telegram: "M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z",
  datadog: "M19.57 17.04l-1.997-1.316-1.665 2.782-1.937-.567-1.706 2.604.087.82 9.274-1.71-.538-5.794zm-8.649-2.498l1.488-.204c.241.108.409.15.697.223.45.117.97.23 1.741-.16.18-.088.553-.43.704-.625l6.096-1.106.622 7.527-10.444 1.882zm11.325-2.712l-.602.115L20.488 0 .789 2.285l2.427 19.693 2.306-.334c-.184-.263-.471-.581-.96-.989-.68-.564-.44-1.522-.039-2.127.53-1.022 3.26-2.322 3.106-3.956-.056-.594-.15-1.368-.702-1.898-.02.22.017.432.017.432s-.227-.289-.34-.683c-.112-.15-.2-.199-.319-.4-.085.233-.073.503-.073.503s-.186-.437-.216-.807c-.11.166-.137.48-.137.48s-.241-.69-.186-1.062c-.11-.323-.436-.965-.343-2.424.6.421 1.924.321 2.44-.439.171-.251.288-.939-.086-2.293-.24-.868-.835-2.16-1.066-2.651l-.028.02c.122.395.374 1.223.47 1.625.293 1.218.372 1.642.234 2.204-.116.488-.397.808-1.107 1.165-.71.358-1.653-.514-1.713-.562-.69-.55-1.224-1.447-1.284-1.883-.062-.477.275-.763.445-1.153-.243.07-.514.192-.514.192s.323-.334.722-.624c.165-.109.262-.178.436-.323a9.762 9.762 0 0 0-.456.003s.42-.227.855-.392c-.318-.014-.623-.003-.623-.003s.937-.419 1.678-.727c.509-.208 1.006-.147 1.286.257.367.53.752.817 1.569.996.501-.223.653-.337 1.284-.509.554-.61.99-.688.99-.688s-.216.198-.274.51c.314-.249.66-.455.66-.455s-.134.164-.259.426l.03.043c.366-.22.797-.394.797-.394s-.123.156-.268.358c.277-.002.838.012 1.056.037 1.285.028 1.552-1.374 2.045-1.55.618-.22.894-.353 1.947.68.903.888 1.609 2.477 1.259 2.833-.294.295-.874-.115-1.516-.916a3.466 3.466 0 0 1-.716-1.562 1.533 1.533 0 0 0-.497-.85s.23.51.23.96c0 .246.03 1.165.424 1.68-.039.076-.057.374-.1.43-.458-.554-1.443-.95-1.604-1.067.544.445 1.793 1.468 2.273 2.449.453.927.186 1.777.416 1.997.065.063.976 1.197 1.15 1.767.306.994.019 2.038-.381 2.685l-1.117.174c-.163-.045-.273-.068-.42-.153.08-.143.241-.5.243-.572l-.063-.111c-.348.492-.93.97-1.414 1.245-.633.359-1.363.304-1.838.156-1.348-.415-2.623-1.327-2.93-1.566 0 0-.01.191.048.234.34.383 1.119 1.077 1.872 1.56l-1.605.177.759 5.908c-.337.048-.39.071-.757.124-.325-1.147-.946-1.895-1.624-2.332-.599-.384-1.424-.47-2.214-.314l-.05.059a2.851 2.851 0 0 1 1.863.444c.654.413 1.181 1.481 1.375 2.124.248.822.42 1.7-.248 2.632-.476.662-1.864 1.028-2.986.237.3.481.705.876 1.25.95.809.11 1.577-.03 2.106-.574.452-.464.69-1.434.628-2.456l.714-.104.258 1.834 11.827-1.424zM15.05 6.848c-.034.075-.085.125-.007.37l.004.014.013.032.032.073c.14.287.295.558.552.696.067-.011.136-.019.207-.023.242-.01.395.028.492.08.009-.048.01-.119.005-.222-.018-.364.072-.982-.626-1.308-.264-.122-.634-.084-.757.068a.302.302 0 0 1 .058.013c.186.066.06.13.027.207m1.958 3.392c-.092-.05-.52-.03-.821.005-.574.068-1.193.267-1.328.372-.247.191-.135.523.047.66.511.382.96.638 1.432.575.29-.038.546-.497.728-.914.124-.288.124-.598-.058-.698m-5.077-2.942c.162-.154-.805-.355-1.556.156-.554.378-.571 1.187-.041 1.646.053.046.096.078.137.104a4.77 4.77 0 0 1 1.396-.412c.113-.125.243-.345.21-.745-.044-.542-.455-.456-.146-.749",
  sentry: "M13.91 2.505c-.873-1.448-2.972-1.448-3.844 0L6.904 7.92a15.478 15.478 0 0 1 8.53 12.811h-2.221A13.301 13.301 0 0 0 5.784 9.814l-2.926 5.06a7.65 7.65 0 0 1 4.435 5.848H2.194a.365.365 0 0 1-.298-.534l1.413-2.402a5.16 5.16 0 0 0-1.614-.913L.296 19.275a2.182 2.182 0 0 0 .812 2.999 2.24 2.24 0 0 0 1.086.288h6.983a9.322 9.322 0 0 0-3.845-8.318l1.11-1.922a11.47 11.47 0 0 1 4.95 10.24h5.915a17.242 17.242 0 0 0-7.885-15.28l2.244-3.845a.37.37 0 0 1 .504-.13c.255.14 9.75 16.708 9.928 16.9a.365.365 0 0 1-.327.543h-2.287c.029.612.029 1.223 0 1.831h2.297a2.206 2.206 0 0 0 1.922-3.31z",
  pagerduty: "M16.965 1.18C15.085.164 13.769 0 10.683 0H3.73v14.55h6.926c2.743 0 4.8-.164 6.61-1.37 1.975-1.303 3.004-3.484 3.004-6.007 0-2.716-1.262-4.896-3.305-5.994zm-5.5 10.326h-4.21V3.113l3.977-.027c3.62-.028 5.43 1.234 5.43 4.128 0 3.113-2.248 4.292-5.197 4.292zM3.73 17.61h3.525V24H3.73Z",
  opsgenie: "M12.002 0a5.988 5.988 0 1 1 0 11.975 5.988 5.988 0 0 1 0-11.975zm9.723 13.026h-.03l-4.527-2.242a.671.671 0 0 0-.876.268 22.408 22.408 0 0 1-4.306 5.217 22.407 22.407 0 0 1-4.286-5.2.671.671 0 0 0-.876-.269l-4.535 2.226h-.03a.671.671 0 0 0-.248.902 28.85 28.85 0 0 0 4.55 5.933l-.002.001c.024.025.05.048.075.072.335.335.676.664 1.027.981.081.074.165.144.247.217.315.278.632.555.96.82.144.117.295.227.441.341.277.216.552.434.837.639.44.318.888.625 1.346.917a.963.963 0 0 0 1.007.017c.487-.312.962-.64 1.428-.98.068-.05.132-.103.2-.153.358-.266.713-.537 1.06-.82.234-.19.46-.39.688-.588.17-.147.34-.291.506-.442.295-.268.58-.545.864-.825.061-.06.127-.118.188-.179l-.004-.002a28.852 28.852 0 0 0 4.565-5.949.671.671 0 0 0-.269-.902z",
  posthog: "M9.854 14.5 5 9.647.854 5.5A.5.5 0 0 0 0 5.854V8.44a.5.5 0 0 0 .146.353L5 13.647l.147.146L9.854 18.5l.146.147v-.049c.065.03.134.049.207.049h2.586a.5.5 0 0 0 .353-.854L9.854 14.5zm0-5-4-4a.487.487 0 0 0-.409-.144.515.515 0 0 0-.356.21.493.493 0 0 0-.089.288V8.44a.5.5 0 0 0 .147.353l9 9a.5.5 0 0 0 .853-.354v-2.585a.5.5 0 0 0-.146-.354l-5-5zm1-4a.5.5 0 0 0-.854.354V8.44a.5.5 0 0 0 .147.353l4 4a.5.5 0 0 0 .853-.354V9.854a.5.5 0 0 0-.146-.354l-4-4zm12.647 11.515a3.863 3.863 0 0 1-2.232-1.1l-4.708-4.707a.5.5 0 0 0-.854.354v6.585a.5.5 0 0 0 .5.5H23.5a.5.5 0 0 0 .5-.5v-.6c0-.276-.225-.497-.499-.532zm-5.394.032a.8.8 0 1 1 0-1.6.8.8 0 0 1 0 1.6zM.854 15.5a.5.5 0 0 0-.854.354v2.293a.5.5 0 0 0 .5.5h2.293c.222 0 .39-.135.462-.309a.493.493 0 0 0-.109-.545L.854 15.501zM5 14.647.854 10.5a.5.5 0 0 0-.854.353v2.586a.5.5 0 0 0 .146.353L4.854 18.5l.146.147h2.793a.5.5 0 0 0 .353-.854L5 14.647z",
  linear: "M2.886 4.18A11.982 11.982 0 0 1 11.99 0C18.624 0 24 5.376 24 12.009c0 3.64-1.62 6.903-4.18 9.105L2.887 4.18ZM1.817 5.626l16.556 16.556c-.524.33-1.075.62-1.65.866L.951 7.277c.247-.575.537-1.126.866-1.65ZM.322 9.163l14.515 14.515c-.71.172-1.443.282-2.195.322L0 11.358a12 12 0 0 1 .322-2.195Zm-.17 4.862 9.823 9.824a12.02 12.02 0 0 1-9.824-9.824Z",
  jira: "M11.571 11.513H0a5.218 5.218 0 0 0 5.232 5.215h2.13v2.057A5.215 5.215 0 0 0 12.575 24V12.518a1.005 1.005 0 0 0-1.005-1.005zm5.723-5.756H5.736a5.215 5.215 0 0 0 5.215 5.214h2.129v2.058a5.218 5.218 0 0 0 5.215 5.214V6.758a1.001 1.001 0 0 0-1.001-1.001zM23.013 0H11.455a5.215 5.215 0 0 0 5.215 5.215h2.129v2.057A5.215 5.215 0 0 0 24 12.483V1.005A1.001 1.001 0 0 0 23.013 0Z",
  algolia: "M12 0C5.445 0 .103 5.285.01 11.817c-.097 6.634 5.285 12.131 11.92 12.17a11.91 11.91 0 0 0 5.775-1.443.281.281 0 0 0 .052-.457l-1.122-.994a.79.79 0 0 0-.833-.14 9.693 9.693 0 0 1-3.923.77c-5.36-.067-9.692-4.527-9.607-9.888.084-5.293 4.417-9.573 9.73-9.573h9.73v17.296l-5.522-4.907a.407.407 0 0 0-.596.063 4.52 4.52 0 0 1-3.934 1.793 4.538 4.538 0 0 1-4.192-4.168 4.53 4.53 0 0 1 4.512-4.872 4.532 4.532 0 0 1 4.509 4.126c.018.205.11.397.265.533l1.438 1.275a.28.28 0 0 0 .462-.158 6.82 6.82 0 0 0 .099-1.725c-.232-3.376-2.966-6.092-6.345-6.3-3.873-.24-7.11 2.79-7.214 6.588-.1 3.7 2.933 6.892 6.634 6.974a6.75 6.75 0 0 0 4.136-1.294l7.212 6.394a.48.48 0 0 0 .797-.36V.456A.456.456 0 0 0 23.54 0Z",
  meilisearch: "m6.505 18.998 4.434-11.345a4.168 4.168 0 0 1 3.882-2.651h2.674l-4.434 11.345a4.169 4.169 0 0 1-3.883 2.651H6.505Zm6.505 0 4.434-11.345a4.169 4.169 0 0 1 3.883-2.651H24l-4.434 11.345a4.168 4.168 0 0 1-3.882 2.651H13.01Zm-13.01 0L4.434 7.653a4.168 4.168 0 0 1 3.882-2.651h2.674L6.556 16.347a4.169 4.169 0 0 1-3.883 2.651H0Z",
  typesense: "M12 0 1.607 6v12L12 24l10.393-6V6L12 0Zm0 2.31 8.393 4.845v9.69L12 21.69 3.607 16.845V7.155L12 2.31Zm0 3.267a2.077 2.077 0 1 0 0 4.154 2.077 2.077 0 0 0 0-4.154Zm-3.75 5.538v1.731h1.442v4.037c0 1.36 1.014 2.135 2.481 2.135.567 0 1.128-.086 1.577-.23v-1.788a3.51 3.51 0 0 1-.98.144c-.66 0-1.096-.288-1.096-.98v-3.318h2.076v-1.73H11.674V8.712l-2.058.605v1.798H8.25Z",
  googlesheets: "M11.318 12.545H7.91v-1.909h3.408v1.91zM14.727 0v6h6l-6-6zm1.363 10.636H7.91v6.982h8.18v-6.982zm-1.363 5.62h-3.41v-1.91h3.41v1.91zM20.727 6.68v15.045c0 .724-.588 1.312-1.312 1.312H4.585a1.313 1.313 0 0 1-1.312-1.312V2.275c0-.724.588-1.312 1.312-1.312h9.446L20.727 6.68zm-3.273 2.32H6.545v9.818h10.91V9z",
  airtable: "M11.992 1.966c-.434 0-.87.086-1.28.257L1.779 5.917c-.503.208-.49.908.012 1.116l8.982 3.558a3.266 3.266 0 0 0 2.454 0l8.982-3.558c.503-.196.503-.908.012-1.116l-8.957-3.694a3.255 3.255 0 0 0-1.272-.257zM23.4 8.056a.589.589 0 0 0-.222.045l-10.012 3.877a.612.612 0 0 0-.38.564v9.884a.606.606 0 0 0 .831.552L23.63 19.1a.612.612 0 0 0 .38-.564V8.653a.6.6 0 0 0-.61-.597zM.676 8.075a.61.61 0 0 0-.485.24.62.62 0 0 0-.114.363v9.885c0 .245.146.466.38.564l10.011 3.877c.398.171.83-.135.83-.552v-9.884a.612.612 0 0 0-.38-.564L.907 8.13a.606.606 0 0 0-.231-.055z",
  quickbooks: "M12 24C5.383 24 0 18.617 0 12S5.383 0 12 0s12 5.383 12 12-5.383 12-12 12zM6.667 7.333a4.667 4.667 0 1 0 0 9.334h.666v-1.734h-.666a2.933 2.933 0 1 1 0-5.866h1.6v9.2a1.734 1.734 0 0 0 1.733 1.733V7.333H6.667zm10.666 9.334a4.667 4.667 0 1 0 0-9.334h-.666v1.734h.666a2.933 2.933 0 1 1 0 5.866h-1.6v-9.2a1.734 1.734 0 0 0-1.733-1.733v12.667h3.333z",
  xero: "M12 0C5.372 0 0 5.372 0 12s5.372 12 12 12 12-5.372 12-12S18.628 0 12 0zM7.06 15.516a.79.79 0 0 1-1.116 0 .79.79 0 0 1 0-1.117l2.4-2.399-2.4-2.4a.79.79 0 0 1 1.117-1.117l2.399 2.4 2.4-2.4a.79.79 0 1 1 1.117 1.117l-2.4 2.4 2.4 2.399a.79.79 0 0 1-1.117 1.117l-2.4-2.4-2.399 2.4zm10.06.076a1.09 1.09 0 1 1 0-2.18 1.09 1.09 0 0 1 0 2.18z",
  notion: "M4.459 4.208c.746.606 1.026.56 2.428.466l13.215-.793c.28 0 .047-.28-.046-.326L17.86 1.968c-.42-.326-.981-.7-2.055-.607L3.01 2.295c-.466.046-.56.28-.374.466zm.793 3.08v13.904c0 .747.373 1.027 1.214.98l14.523-.84c.841-.046.935-.56.935-1.167V6.354c0-.606-.233-.933-.748-.887l-15.177.887c-.56.047-.747.327-.747.933zm14.337.745c.093.42 0 .84-.42.888l-.7.14v10.264c-.608.327-1.168.514-1.635.514-.748 0-.935-.234-1.495-.933l-4.577-7.186v6.952L12.21 19s0 .84-1.168.84l-3.222.186c-.093-.186 0-.653.327-.746l.84-.233V9.854L7.822 9.76c-.094-.42.14-1.026.793-1.073l3.456-.233 4.764 7.279v-6.44l-1.215-.139c-.093-.514.28-.887.747-.933zM1.936 1.035l13.31-.98c1.634-.14 2.055-.047 3.082.7l4.249 2.986c.7.513.934.653.934 1.213v16.378c0 1.026-.373 1.634-1.68 1.726l-15.458.934c-.98.047-1.448-.093-1.962-.747l-3.129-4.06c-.56-.747-.793-1.306-.793-1.96V2.667c0-.839.374-1.54 1.447-1.632z",
  elasticsearch: "M13.394 0C10.07 0 7.147 1.699 5.44 4.276h13.531A6.61 6.61 0 0 0 13.394 0ZM4.298 6.276a10.53 10.53 0 0 0-.548 2.752h15.727a3.377 3.377 0 0 0 0-2.752H4.298Zm-.548 6.696c.062.945.25 1.867.548 2.752h15.179a3.377 3.377 0 0 0 0-2.752H3.75Zm1.69 6.752A10.588 10.588 0 0 0 13.394 24a6.61 6.61 0 0 0 5.577-4.276H5.44Z",
};
const SI = ({ d }: { d: string }) => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <path d={d} />
  </svg>
);

/** Brand presentation per provider — coloured mark + label for the cards. */
type Brand = { name: string; mark: ReactNode; markBg: string };
const BRANDS: Record<string, Brand> = {
  slack: { name: "Slack", mark: <SI d={ICONS.slack!} />, markBg: "#4A154B" },
  discord: { name: "Discord", mark: <SI d={ICONS.discord!} />, markBg: "#5865F2" },
  teams: { name: "Microsoft Teams", mark: <SI d={ICONS.teams!} />, markBg: "#6264A7" },
  telegram: { name: "Telegram", mark: <SI d={ICONS.telegram!} />, markBg: "#26A5E4" },
  github: { name: "GitHub", mark: <GithubMark />, markBg: "#181717" },
  datadog: { name: "Datadog", mark: <SI d={ICONS.datadog!} />, markBg: "#632CA6" },
  sentry: { name: "Sentry", mark: <SI d={ICONS.sentry!} />, markBg: "#362D59" },
  pagerduty: { name: "PagerDuty", mark: <SI d={ICONS.pagerduty!} />, markBg: "#06AC38" },
  opsgenie: { name: "Opsgenie", mark: <SI d={ICONS.opsgenie!} />, markBg: "#172B4D" },
  posthog: { name: "PostHog", mark: <SI d={ICONS.posthog!} />, markBg: "#1D4AFF" },
  segment: { name: "Segment", mark: "Sg", markBg: "#52BD94" },
  linear: { name: "Linear", mark: <SI d={ICONS.linear!} />, markBg: "#5E6AD2" },
  jira: { name: "Jira", mark: <SI d={ICONS.jira!} />, markBg: "#0052CC" },
  algolia: { name: "Algolia", mark: <SI d={ICONS.algolia!} />, markBg: "#003DFF" },
  meilisearch: { name: "Meilisearch", mark: <SI d={ICONS.meilisearch!} />, markBg: "#FF5CAA" },
  typesense: { name: "Typesense", mark: <SI d={ICONS.typesense!} />, markBg: "#D52B7C" },
  // One card covers both engines — OpenSearch is an Elasticsearch 7.x fork and
  // speaks the same index/update API, so the adapter and the credentials match.
  elasticsearch: { name: "Elasticsearch / OpenSearch", mark: <SI d={ICONS.elasticsearch!} />, markBg: "#005571" },
  notion: { name: "Notion", mark: <SI d={ICONS.notion!} />, markBg: "#000000" },
  "google-sheets": { name: "Google Sheets", mark: <SI d={ICONS.googlesheets!} />, markBg: "#34A853" },
  "google-drive": { name: "Google Drive", mark: "GD", markBg: "#1FA463" },
  "google-calendar": { name: "Google Calendar", mark: "GC", markBg: "#4285F4" },
  contentful: { name: "Contentful", mark: "Cf", markBg: "#2478CC" },
  airtable: { name: "Airtable", mark: <SI d={ICONS.airtable!} />, markBg: "#18BFFF" },
  quickbooks: { name: "QuickBooks Online", mark: <SI d={ICONS.quickbooks!} />, markBg: "#2CA01C" },
  hubspot: { name: "HubSpot", mark: "Hs", markBg: "#FF7A59" },
  // Mailchimp's brand yellow is #FFE01B, which the mark cannot use: it is drawn
  // white-on-brand, and white on that is unreadable. Their dark is the pair.
  mailchimp: { name: "Mailchimp", mark: "Mc", markBg: "#241C15" },
  klaviyo: { name: "Klaviyo", mark: "Kl", markBg: "#000000" },
  mixpanel: { name: "Mixpanel", mark: "Mp", markBg: "#7856FF" },
  amplitude: { name: "Amplitude", mark: "Am", markBg: "#1E61F0" },
  "google-chat": { name: "Google Chat", mark: "GC", markBg: "#00AC47" },
  clickhouse: { name: "ClickHouse", mark: "CH", markBg: "#FFCC01" },
  bigquery: { name: "Google BigQuery", mark: "BQ", markBg: "#4285F4" },
  xero: { name: "Xero", mark: <SI d={ICONS.xero!} />, markBg: "#13B5EA" },
  trendyol: { name: "Trendyol", mark: "Ty", markBg: "#F27A1A" },
  hepsiburada: { name: "Hepsiburada", mark: "Hb", markBg: "#FF6000" },
  n11: { name: "n11", mark: "n11", markBg: "#6C2C7C" },
  ciceksepeti: { name: "Çiçeksepeti", mark: "Çs", markBg: "#E5004C" },
  amazon: { name: "Amazon", mark: "Az", markBg: "#232F3E" },
  easypost: { name: "EasyPost", mark: "Ep", markBg: "#164DFF" },
};
const brandFor = (kind: string): Brand => BRANDS[kind] ?? { name: kind, mark: kind.slice(0, 2).toUpperCase(), markBg: "oklch(0.45 0.02 286)" };

export function IntegrationsPage({ pushToast }: { pushToast: PushToast }) {
  const { t } = useLingui();
  const [catalog, setCatalog] = useState<Catalog>({ kinds: [], fields: {} });
  const [connected, setConnected] = useState<Integration[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [connectKind, setConnectKind] = useState<string | null>(null);
  const [busyKind, setBusyKind] = useState<string | null>(null);
  const [logFor, setLogFor] = useState<Integration | null>(null);

  const reload = async () => {
    const [cat, list] = await Promise.all([
      fetchSafely<{ data: Catalog }>("/api/admin/integrations/catalog"),
      fetchSafely<{ data: Integration[] }>("/api/admin/integrations"),
    ]);
    if (cat) setCatalog(cat.data);
    if (list) setConnected(list.data);
    setLoaded(true);
  };
  useEffect(() => {
    void reload();
  }, []);

  // The OAuth callback redirects here with a fixed status slug. Report it and
  // drop the param so a refresh does not repeat the toast.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const status = params.get("oauth");
    if (!status) return;
    pushToast(
      status === "connected"
        ? t`Account connected.`
        : status === "denied"
          ? t`Authorization was cancelled.`
          : status === "signed_out"
            ? t`Sign in again and retry the connection.`
            : t`Authorization failed. Check the client ID, secret and redirect URI, then retry.`,
    );
    params.delete("oauth");
    const qs = params.toString();
    window.history.replaceState(null, "", window.location.pathname + (qs ? `?${qs}` : ""));
    if (status === "connected") void reload();
  }, []);

  const byKind = new Map(connected.map((i) => [i.kind, i]));
  const oauthKinds = new Set((catalog.providers ?? []).filter((p) => p.oauth).map((p) => p.id));
  const sourceKinds = new Set(
    (catalog.providers ?? []).filter((p) => p.capabilities.includes("source")).map((p) => p.id),
  );
  const recordPayloadKinds = new Set(
    (catalog.providers ?? []).filter((p) => p.recordPayload).map((p) => p.id),
  );
  const webhookKinds = new Set(
    (catalog.providers ?? []).filter((p) => p.capabilities.includes("webhook")).map((p) => p.id),
  );
  const destinationKinds = new Set(
    (catalog.providers ?? []).filter((p) => p.capabilities.includes("destination")).map((p) => p.id),
  );
  /** An OAuth row exists but has no token yet — credentials saved, not authorized. */
  const needsAuthorize = (it: Integration | undefined) =>
    Boolean(it) && oauthKinds.has(it!.kind) && !it!.config?.[OAUTH_TOKEN_KEY];

  // Send the admin to the provider's consent screen. A full navigation, not a
  // popup: the callback has to land back in this same session, and a popup
  // blocked by the browser would look like the button doing nothing.
  const authorize = async (it: Integration) => {
    setBusyKind(it.kind);
    try {
      const res = await api<{ data: { url: string } }>(`/api/admin/integrations/${it.id}/oauth/authorize`, {
        method: "POST",
      });
      window.location.href = res.data.url;
    } catch (e) {
      pushToast((e as Error).message);
      setBusyKind(null);
    }
  };

  // Data-plane event blurb per provider (kept inline so Lingui extracts them).
  const blurb = (kind: string): string => {
    switch (kind) {
      case "notion":
        return t`Append data events to a Notion page, or pull a database into a collection.`;
      case "google-sheets":
        return t`Pull a spreadsheet into a collection on a schedule.`;
      case "google-drive":
        return t`Index a Drive folder's files as a collection. Metadata only.`;
      case "google-calendar":
        return t`Mirror a calendar's events into a collection, including cancellations.`;
      case "contentful":
        return t`Bring Contentful entries into a collection. One-way.`;
      case "airtable":
        return t`Pull an Airtable table into a collection on a schedule.`;
      case "clickhouse":
        return t`Mirror a collection into a ClickHouse table on a schedule.`;
      case "bigquery":
        return t`Mirror a collection into a BigQuery dataset on a schedule.`;
      case "quickbooks":
        return t`Mirror QuickBooks customers, invoices and payments into a collection.`;
      case "xero":
        return t`Mirror Xero contacts, invoices and payments into a collection.`;
      case "slack":
        return t`Post data events to a Slack channel.`;
      case "google-chat":
        return t`Post data events to a Google Chat space.`;
      case "mixpanel":
        return t`Track data events in Mixpanel.`;
      case "amplitude":
        return t`Track data events in Amplitude.`;
      case "hubspot":
        return t`Keep HubSpot contacts in step with a collection. Receives record contents.`;
      case "mailchimp":
        return t`Sync a collection into a Mailchimp audience, and pull subscriber status back.`;
      case "klaviyo":
        return t`Sync a collection into a Klaviyo list, and pull marketing consent back.`;
      case "discord":
        return t`Post data events to a Discord channel.`;
      case "teams":
        return t`Post data events to a Microsoft Teams channel.`;
      case "telegram":
        return t`Send data events to a Telegram chat.`;
      case "datadog":
        return t`Forward data events to the Datadog events API.`;
      case "sentry":
        return t`Forward data events to a Sentry project.`;
      case "pagerduty":
        return t`Trigger PagerDuty alerts on data events.`;
      case "opsgenie":
        return t`Create Opsgenie alerts on data events.`;
      case "posthog":
        return t`Capture data events as PostHog analytics events.`;
      case "segment":
        return t`Track data events through Segment.`;
      case "github":
        return t`Fire a repository_dispatch on data events.`;
      case "linear":
        return t`Create Linear issues from data events.`;
      case "jira":
        return t`Create Jira issues from data events.`;
      case "algolia":
        return t`Sync records to an Algolia index on data events.`;
      case "meilisearch":
        return t`Sync records to a Meilisearch index on data events.`;
      case "typesense":
        return t`Sync records to a Typesense collection on data events.`;
      case "elasticsearch":
        return t`Sync records to an Elasticsearch or OpenSearch index on data events.`;
      case "trendyol":
        return t`Pull marketplace orders in with their lines, push stock and price out, and notify package status back.`;
      case "hepsiburada":
        return t`Mirror marketplace orders and packages in with their lines, push stock and price out, and notify fulfilment back.`;
      case "n11":
        return t`Pull shipment packages in with their lines, push stock and price out, and approve packages back.`;
      case "ciceksepeti":
        return t`Mirror orders in with their sub-orders, push stock and price out, and drive the customer's status notifications.`;
      case "amazon":
        return t`Pull Selling Partner orders in with their lines and addresses, and confirm shipments back.`;
      case "easypost":
        return t`Book a shipment and store its label, read where the parcel is, and cancel it.`;
      default:
        return "";
    }
  };

  // Every mutation below is optimistic: snapshot → apply → reconcile, rolling
  // back to the snapshot on failure. The card must flip the moment it's
  // clicked, never after a round-trip.
  const connect = async (kind: string, config: Record<string, string>, events: string[]) => {
    const snapshot = connected;
    const optimistic: Integration = {
      // Provisional id — replaced by the server's row on reconcile. Nothing
      // addresses the row by id until then.
      id: `pending:${kind}`,
      kind,
      status: "connected",
      config: {},
      events: events.length ? events : null,
      lastEventAt: null,
      consecutiveFailures: 0,
    };
    setConnected([...snapshot.filter((i) => i.kind !== kind), optimistic]);
    setConnectKind(null);
    setBusyKind(kind);
    try {
      const res = await api<{ data: Integration }>("/api/admin/integrations", {
        method: "POST",
        body: JSON.stringify({ kind, config, events: events.length ? events : null }),
      });
      setConnected((prev) => prev.map((i) => (i.id === optimistic.id ? res.data : i)));
      pushToast(t`${brandFor(kind).name} connected.`);
    } catch (e) {
      setConnected(snapshot);
      pushToast((e as Error).message);
    } finally {
      setBusyKind(null);
    }
  };

  const disconnect = async (it: Integration) => {
    const snapshot = connected;
    setConnected(snapshot.filter((i) => i.id !== it.id));
    setBusyKind(it.kind);
    try {
      await api(`/api/admin/integrations/${it.id}`, { method: "DELETE" });
      pushToast(t`${brandFor(it.kind).name} disconnected.`);
    } catch (e) {
      setConnected(snapshot);
      pushToast((e as Error).message);
    } finally {
      setBusyKind(null);
    }
  };

  const resume = async (it: Integration) => {
    const snapshot = connected;
    setConnected(
      snapshot.map((i) =>
        i.id === it.id ? { ...i, status: "connected", consecutiveFailures: 0, disabledReason: null } : i,
      ),
    );
    setBusyKind(it.kind);
    try {
      const res = await api<{ data: Integration }>(`/api/admin/integrations/${it.id}/resume`, { method: "POST" });
      setConnected((prev) => prev.map((i) => (i.id === it.id ? res.data : i)));
      pushToast(t`${brandFor(it.kind).name} resumed.`);
    } catch (e) {
      setConnected(snapshot);
      pushToast((e as Error).message);
    } finally {
      setBusyKind(null);
    }
  };

  const skeletonKinds = catalog.kinds.length ? catalog.kinds : ["slack", "discord", "datadog", "github"];

  return (
    <div className="flex flex-col gap-4.5">
      <PageHeader
        title={t`Integrations`}
        description={t`Fan record events out to chat, alerting, analytics, search, and automation tools. Secrets are encrypted at rest.`}
      />

      <div className="grid grid-cols-3 max-[920px]:grid-cols-2 max-[560px]:grid-cols-1 gap-3">
        {!loaded
          ? skeletonKinds.map((k) => (
              <div key={k} className="rounded-control border border-border bg-card p-5 flex flex-col gap-3">
                <div className="flex items-start gap-3">
                  <Skeleton className="h-10 w-10 rounded-control" />
                  <Skeleton className="h-3.5 w-24 mt-1" />
                </div>
                <Skeleton className="h-3 w-full" />
                <Skeleton className="h-8 w-24 mt-auto" />
              </div>
            ))
          : catalog.kinds.map((kind) => {
              const brand = brandFor(kind);
              const it = byKind.get(kind);
              const isConnected = it?.status === "connected";
              const isDisabled = it?.status === "disabled";
              const failures = it?.consecutiveFailures ?? 0;
              const busy = busyKind === kind;
              // Credentials are saved but the admin has not been to the consent
              // screen yet, so nothing will actually deliver.
              const pending = needsAuthorize(it);
              return (
                <div key={kind} className="rounded-control border border-border bg-card p-5 flex flex-col gap-3">
                  <div className="flex items-start gap-3">
                    <span
                      className="w-10 h-10 rounded-control grid place-items-center font-bold text-white text-[14px] shrink-0"
                      style={{ background: brand.markBg }}
                    >
                      {brand.mark}
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <h3 className="text-[14px] font-semibold">{brand.name}</h3>
                        {isConnected && !pending && (
                          <Badge variant="default" className="text-[10px]">
                            <Trans>Connected</Trans>
                          </Badge>
                        )}
                        {pending && (
                          <Badge variant="secondary" className="text-[10px]">
                            <Trans>Not authorized</Trans>
                          </Badge>
                        )}
                        {isDisabled && (
                          <Badge variant="destructive" className="text-[10px]">
                            <Trans>Paused</Trans>
                          </Badge>
                        )}
                      </div>
                      {isConnected && it?.lastEventAt ? (
                        <div className="text-[11.5px] text-muted-foreground truncate">
                          <Trans>last event {relativeTime(it.lastEventAt)}</Trans>
                        </div>
                      ) : null}
                      {isConnected && failures > 0 ? (
                        <div className="text-[11.5px] text-destructive truncate">
                          <Trans>{failures} failed deliveries in a row</Trans>
                        </div>
                      ) : null}
                    </div>
                  </div>
                  {isDisabled && it?.disabledReason ? (
                    <p className="text-[11.5px] text-destructive leading-snug">{it.disabledReason}</p>
                  ) : pending ? (
                    <p className="text-[12px] text-muted-foreground leading-snug flex-1">
                      <Trans>
                        Client credentials saved. Finish by authorizing the account — nothing is delivered until
                        you do.
                      </Trans>
                    </p>
                  ) : (
                    <p className="text-[12px] text-muted-foreground leading-snug flex-1">{blurb(kind)}</p>
                  )}
                  <div className="mt-auto flex flex-wrap items-center gap-2">
                    {it ? (
                      <>
                        {pending && (
                          <Button disabled={busy} onClick={() => void authorize(it)}>
                            {busy ? <Trans>Opening…</Trans> : <Trans>Authorize</Trans>}
                          </Button>
                        )}
                        {isDisabled && (
                          <Button disabled={busy} onClick={() => void resume(it)}>
                            {busy ? <Trans>Resuming…</Trans> : <Trans>Resume</Trans>}
                          </Button>
                        )}
                        {oauthKinds.has(kind) && !pending && (
                          <Button variant="ghost" disabled={busy} onClick={() => void authorize(it)}>
                            <Trans>Reauthorize</Trans>
                          </Button>
                        )}
                        <Button variant="ghost" onClick={() => setLogFor(it)}>
                          <Trans>Deliveries</Trans>
                        </Button>
                        <Button variant="ghost" disabled={busy} onClick={() => void disconnect(it)}>
                          {busy ? <Trans>Disconnecting…</Trans> : <Trans>Disconnect</Trans>}
                        </Button>
                      </>
                    ) : (
                      <Button disabled={busy} onClick={() => setConnectKind(kind)}>
                        {busy ? <Trans>Connecting…</Trans> : <Trans>Connect</Trans>}
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
      </div>

      {connectKind && (
        <ConnectDialog
          kind={connectKind}
          name={brandFor(connectKind).name}
          fields={catalog.fields[connectKind] ?? []}
          redirectUri={oauthKinds.has(connectKind) ? (catalog.oauthRedirectUri ?? null) : null}
          receivesRecords={recordPayloadKinds.has(connectKind)}
          existing={byKind.get(connectKind) ?? null}
          busy={busyKind === connectKind}
          onClose={() => setConnectKind(null)}
          onConnect={(config, events) => void connect(connectKind, config, events)}
        />
      )}

      <IntegrationSyncsCard
        // Only authorized sources can be pulled from: an unauthorized row would
        // offer a sync that fails on its first run with a credential error.
        sources={[
          // Only authorized sources: an unauthorized row would offer a sync
          // that fails on its first run with a credential error.
          ...connected
            .filter((i) => sourceKinds.has(i.kind) && !needsAuthorize(i))
            .map((i) => ({ id: i.id, kind: i.kind, label: brandFor(i.kind).name, direction: "pull" as const })),
          // Same authorize gate as the pull side. It only started mattering
          // when a destination arrived that connects over OAuth (Calendar):
          // offering an unauthorized one produces a sync that fails on its
          // first run with a token error.
          ...connected
            .filter((i) => destinationKinds.has(i.kind) && !needsAuthorize(i))
            .map((i) => ({ id: i.id, kind: i.kind, label: brandFor(i.kind).name, direction: "push" as const })),
          // A provider that CALLS US, and has no source to poll, still needs a
          // row to land its deliveries through — that row is what holds the
          // collection, the mapping and the endpoint. Offered only where there
          // is nothing to pull: a marketplace already appears above as a pull,
          // and its endpoint hangs on that same sync so the two converge on one
          // row instead of writing two.
          ...connected
            .filter(
              (i) => webhookKinds.has(i.kind) && !sourceKinds.has(i.kind) && !needsAuthorize(i),
            )
            .map((i) => ({
              id: i.id,
              kind: i.kind,
              label: brandFor(i.kind).name,
              direction: "inbound" as const,
            })),
        ]}
        // Keyed by direction so one provider could declare both without the
        // dialog having to guess which set it is looking at.
        settingFields={{
          ...Object.fromEntries(
            Object.entries(catalog.sourceSettings ?? {}).map(([k, v]) => [`${k}:pull`, v]),
          ),
          ...Object.fromEntries(
            Object.entries(catalog.destinationSettings ?? {}).map(([k, v]) => [`${k}:push`, v]),
          ),
        }}
        destinationColumns={catalog.destinationColumns ?? {}}
        childGroups={catalog.sourceChildGroups ?? {}}
        webhooks={catalog.webhooks ?? {}}
        pushToast={pushToast}
      />

      {logFor && (
        <DeliveryLogDialog
          integration={logFor}
          name={brandFor(logFor.kind).name}
          onClose={() => setLogFor(null)}
        />
      )}
    </div>
  );
}

/* ── Delivery log: every attempt for one integration, newest first ── */
function DeliveryLogDialog({
  integration,
  name,
  onClose,
}: {
  integration: Integration;
  name: string;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const [rows, setRows] = useState<Delivery[] | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      const res = await fetchSafely<{ data: Delivery[] }>(
        `/api/admin/integrations/${integration.id}/deliveries`,
      );
      if (live) setRows(res?.data ?? []);
    })();
    return () => {
      live = false;
    };
  }, [integration.id]);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="w-full gap-0 p-0 sm:max-w-[560px]">
        <DialogHeader className="shrink-0 space-y-1 border-b border-border px-5 pt-5 pb-3.5 text-left">
          <DialogTitle className="text-[15px] font-semibold -tracking-[0.01em]">{t`${name} deliveries`}</DialogTitle>
          <DialogDescription className="text-[12.5px] text-muted-foreground">
            <Trans>Newest first. One row per attempt, including queue retries.</Trans>
          </DialogDescription>
        </DialogHeader>

        <DialogBody>
          <div className="flex flex-col gap-1.5 px-5 py-4">
            {rows === null ? (
              [0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-11 w-full" />)
            ) : rows.length === 0 ? (
              <p className="text-[12px] text-muted-foreground">
                <Trans>No deliveries yet — they appear here as records change.</Trans>
              </p>
            ) : (
              rows.map((d) => {
                const ok = d.status >= 200 && d.status < 300;
                return (
                  <div
                    key={d.id}
                    className="flex items-center gap-3 rounded-control border border-border px-3 py-2"
                  >
                    <Badge variant={ok ? "default" : "destructive"} className="shrink-0 text-[10px] tabular-nums">
                      {d.status === 0 ? t`failed` : d.status}
                    </Badge>
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-mono text-[11.5px]">{d.event}</div>
                      {d.error ? (
                        <div className="truncate text-[11px] text-destructive">{d.error}</div>
                      ) : null}
                    </div>
                    <div className="shrink-0 text-right text-[11px] text-muted-foreground">
                      <div>{relativeTime(d.deliveredAt)}</div>
                      <div className="tabular-nums">
                        {d.attempts > 1 ? (
                          <Trans>
                            {d.ms}ms · try {d.attempts}
                          </Trans>
                        ) : (
                          <Trans>{d.ms}ms</Trans>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </DialogBody>

        <DialogFooter className="shrink-0 border-t border-border px-5 py-3.5">
          <Button variant="ghost" onClick={onClose}>
            <Trans>Close</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ── Connect an integration: provider credentials + event subscriptions ── */
function ConnectDialog({
  name,
  fields,
  redirectUri,
  receivesRecords,
  existing,
  busy,
  onClose,
  onConnect,
}: {
  kind: string;
  name: string;
  fields: Field[];
  /** Non-null for OAuth providers: the URI to register with the provider. */
  redirectUri: string | null;
  /** True when row contents — not just event names — leave the instance. */
  receivesRecords: boolean;
  existing: Integration | null;
  busy: boolean;
  onClose: () => void;
  onConnect: (config: Record<string, string>, events: string[]) => void;
}) {
  const { t } = useLingui();
  const collectionsQuery = useCollections();
  const collections = collectionsQuery.data?.data ?? [];
  // Data-plane events are `<collection>.<action>`; a `<slug>.*` subscription
  // (matchesEventFilter prefix wildcard) covers create/update/delete for one
  // collection. No selection = all events.
  const eventOptions = collections.map((c) => `${c.slug}.*`);

  const [values, setValues] = useState<Record<string, string>>({});
  const [events, setEvents] = useState<Set<string>>(new Set(existing?.events ?? []));
  const toggleEvent = (e: string) =>
    setEvents((prev) => {
      const next = new Set(prev);
      if (next.has(e)) next.delete(e);
      else next.add(e);
      return next;
    });

  // Required = every field whose label doesn't say "optional".
  const ready = fields.every(
    (f) => f.label.toLowerCase().includes("optional") || (values[f.key]?.trim().length ?? 0) > 0,
  );

  const submit = () => {
    const config: Record<string, string> = {};
    for (const [k, v] of Object.entries(values)) if (v.trim()) config[k] = v.trim();
    onConnect(config, [...events]);
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="w-full gap-0 p-0 sm:max-w-[520px]">
        <DialogHeader className="space-y-1 border-b border-border px-5 pt-5 pb-3.5 text-left">
          <DialogTitle className="text-[15px] font-semibold -tracking-[0.01em]">{t`Connect ${name}`}</DialogTitle>
          <DialogDescription className="text-[12.5px] text-muted-foreground">
            {redirectUri ? (
              <Trans>
                Register your own OAuth app with {name}, then save its client ID and secret here. Saving does not
                connect the account — you authorize it in the next step.
              </Trans>
            ) : (
              <Trans>Credentials are encrypted at rest and never shown again.</Trans>
            )}
          </DialogDescription>
        </DialogHeader>

        <DialogBody>
          <div className="flex flex-col gap-3.5 px-5 py-4">
            {redirectUri ? (
              <div className="rounded-control border border-border bg-muted/40 px-3 py-2.5">
                <span className="mb-1 block text-[11.5px] font-medium">
                  <Trans>Redirect URI to register</Trans>
                </span>
                {/* Read-only and selectable rather than a copy button with its
                    own state: the provider's form needs this pasted verbatim,
                    and typing it by hand is the usual cause of a failed leg 2. */}
                <code className="block break-all text-[11px] text-muted-foreground select-all">{redirectUri}</code>
              </div>
            ) : null}
            {receivesRecords ? (
              // Said before connecting, not after. Every other sink is told
              // that something changed; this one is told what it said.
              <div className="rounded-control border border-destructive/40 bg-destructive/5 px-3 py-2.5">
                <span className="mb-1 block text-[11.5px] font-medium text-destructive">
                  <Trans>This provider receives your record contents</Trans>
                </span>
                <span className="block text-[11px] leading-snug text-muted-foreground">
                  <Trans>
                    Unlike the other integrations, it needs the row itself — not just the fact that one
                    changed. Use the event list below to scope which collections that applies to.
                  </Trans>
                </span>
              </div>
            ) : null}
            {fields.map((f) => (
              <label key={f.key} className="block">
                <span className="mb-1 block text-[11.5px] font-medium">{f.label}</span>
                {f.options ? (
                  <Select
                    value={values[f.key] || undefined}
                    onChange={(v: string) => setValues((prev) => ({ ...prev, [f.key]: v }))}
                    placeholder={f.placeholder ?? t`Choose one`}
                    options={f.options}
                    className="min-w-0"
                  />
                ) : (
                  <Input
                    type={f.secret ? "password" : "text"}
                    placeholder={f.placeholder}
                    value={values[f.key] ?? ""}
                    onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                  />
                )}
              </label>
            ))}

            <div>
              <span className="mb-1.5 block text-[11.5px] font-medium">
                <Trans>Events</Trans>{" "}
                <span className="font-normal text-muted-foreground">
                  · <Trans>none selected = all</Trans>
                </span>
              </span>
              {eventOptions.length === 0 ? (
                <p className="text-[11.5px] text-muted-foreground">
                  <Trans>No collections yet — events fire once you create one.</Trans>
                </p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {eventOptions.map((e) => {
                    const on = events.has(e);
                    return (
                      <button
                        key={e}
                        type="button"
                        onClick={() => toggleEvent(e)}
                        className={`rounded-control border px-2 py-1 font-mono text-[11px] transition-colors ${
                          on
                            ? "border-primary bg-primary/10 text-foreground"
                            : "border-border text-muted-foreground hover:bg-muted hover:text-foreground"
                        }`}
                      >
                        {e}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </DialogBody>

        <DialogFooter className="border-t border-border px-5 py-3.5">
          <Button variant="ghost" onClick={onClose}>
            <Trans>Cancel</Trans>
          </Button>
          <Button onClick={submit} disabled={busy || !ready}>
            {busy ? (
              <Trans>Connecting…</Trans>
            ) : redirectUri ? (
              <Trans>Save credentials</Trans>
            ) : (
              <Trans>Connect</Trans>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
