export type TerminalInfo = {
  id: string;
  title: string;
  state: "live" | "finished";
  status: "idle" | "working" | "done" | "blocked" | "error" | "unknown";
  cols: number;
  rows: number;
};
export type Tab = { id: string; name: string; terminals: TerminalInfo[] };
export type Space = {
  id: string;
  machineId: string;
  name: string;
  cwd: string;
  repo: string | null;
  branch: string | null;
  color: string;
  tabs: Tab[];
};
export type State = {
  version: 1;
  revision: number;
  machines: { id: string; name: string; online: boolean }[];
  spaces: Space[];
  programs: { id: string; name: string; machineId: string }[];
};
export type Prompt = {
  id: string;
  kind: "approval" | "menu";
  options: { id: string; label: string; keys: string[] }[];
};
export type Screen = {
  terminal: TerminalInfo;
  text: string;
  complete: true;
  screenId: string;
  prompt: Prompt | null;
};
export type Frame =
  | { type: "state"; state: State }
  | {
      type: "screen";
      terminalId: string;
      watchId: string;
      cols: number;
      rows: number;
      text: string;
      screenId: string;
      prompt: Prompt | null;
    }
  | {
      type: "output";
      terminalId: string;
      watchId: string;
      cols: number;
      rows: number;
      reset: boolean;
      seq: number;
      history: number;
      data: string;
    }
  | { type: "connection"; connected: boolean }
  | { type: "error"; code: string; message: string; terminalId?: string; watchId?: string };

export type ConversationPage = {
  available: boolean;
  reason?: "not_configured" | "not_found" | "ambiguous" | "offline";
  session: string | null;
  revision: string;
  warnings?: Array<"long_output_trimmed" | "scan_limited">;
  turns: { id: string; continuesPrevious?: boolean; entries: { id: string; role: "user" | "assistant" | "tool"; text: string }[] }[];
  nextCursor: string | null;
};

export type UploadedFile = { id: string; name: string; type: string; size: number; converted: boolean };
