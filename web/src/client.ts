import type { Frame, State, Screen } from "./types";
const TOKEN_KEY = "herdr-phone.device";
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code = "",
  ) {
    super(message);
  }
}
export class Client {
  token = localStorage.getItem(TOKEN_KEY) ?? "";
  private queues = new Map<string, Promise<unknown>>();
  private epochs = new Map<string, number>();
  private socket?: WebSocket;
  private reconnect?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private attempt = 0;
  private watched: string | null = null;
  private history = 500;
  watchId = "";
  onWatch: (watchId: string, history: number) => void = () => {};
  onFrame: (frame: Frame) => void = () => {};
  onConnection: (connected: boolean) => void = () => {};
  onUnauthorized: () => void = () => {};
  async request<T>(
    path: string,
    body?: unknown,
    method = body === undefined ? "GET" : "POST",
  ): Promise<T> {
    const response = await fetch(`/api${path}`, {
      method,
      cache: "no-store",
      headers: {
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      const data = await response.json().catch(() => null);
      if (response.status === 401 && path !== "/pair") this.onUnauthorized();
      throw new ApiError(
        response.status,
        data?.error?.message ?? "The bridge could not complete this request.",
        data?.error?.code,
      );
    }
    return response.status === 204 ? (undefined as T) : response.json();
  }
  async pair(code: string, label: string) {
    const data = await this.request<{ token: string }>("/pair", {
      code: code.trim().toUpperCase(),
      label: label.trim(),
    });
    this.token = data.token;
    localStorage.setItem(TOKEN_KEY, this.token);
  }
  state() {
    return this.request<State>("/state");
  }
  screen(id: string) {
    return this.request<Screen>(`/terminals/${encodeURIComponent(id)}/screen`);
  }
  action(id: string, kind: "send" | "keys" | "prompt", body: unknown) {
    const epoch = this.epochs.get(id) ?? 0;
    const next = (this.queues.get(id) ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        if (epoch !== (this.epochs.get(id) ?? 0))
          throw new Error(
            "Pending input was cancelled. Check the terminal before sending again.",
          );
        const result = await this.request(
          `/terminals/${encodeURIComponent(id)}/${kind}`,
          body,
        );
        if (epoch !== (this.epochs.get(id) ?? 0))
          throw new Error("Delivery outcome is unknown after disconnection.");
        return result;
      })
      .catch((error) => {
        if (epoch === (this.epochs.get(id) ?? 0))
          this.epochs.set(id, epoch + 1);
        throw error;
      });
    this.queues.set(id, next);
    return next;
  }
  watch(id: string | null, history = 500) {
    this.watched = id;
    this.history = history;
    this.sendWatch();
  }
  private sendWatch() {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.watchId = crypto.randomUUID();
    this.onWatch(this.watchId, this.history);
    this.socket.send(
        JSON.stringify(
          this.watched
            ? { type: "watch", terminalId: this.watched, watchId: this.watchId, history: this.history }
            : { type: "unwatch" },
        ),
      );
  }
  connect() {
    this.stopped = false;
    if (
      this.socket &&
      (this.socket.readyState === WebSocket.OPEN ||
        this.socket.readyState === WebSocket.CONNECTING)
    )
      return;
    const url = new URL("/api/ws", location.href);
    url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(url, ["herdr-phone.v1", `auth.${this.token}`]);
    this.socket = socket;
    socket.onopen = () => {
      this.attempt = 0;
      this.onConnection(true);
      this.sendWatch();
    };
    socket.onmessage = (event) => {
      try {
        if (
          typeof event.data !== "string" ||
          event.data.length > 4 * 1024 * 1024
        )
          return;
        if (this.socket !== socket) return;
        const frame = JSON.parse(event.data) as Frame;
        if ((frame.type === "screen" || frame.type === "output") &&
            (frame.terminalId !== this.watched || frame.watchId !== this.watchId)) return;
        this.onFrame(frame);
      } catch {
        this.onConnection(false);
      }
    };
    socket.onclose = (event) => {
      if (this.socket !== socket) return;
      this.cancelPending();
      this.onConnection(false);
      if (event.code === 4001) {
        this.onUnauthorized();
        return;
      }
      if (!this.stopped)
        this.reconnect = setTimeout(
          () => this.connect(),
          Math.min(15000, 500 * 2 ** this.attempt++),
        );
    };
    socket.onerror = () => socket.close();
  }
  cancelPending() {
    for (const id of this.queues.keys())
      this.epochs.set(id, (this.epochs.get(id) ?? 0) + 1);
  }
  disconnect() {
    this.stopped = true;
    clearTimeout(this.reconnect);
    this.socket?.close();
    this.socket = undefined;
    this.watch(null);
    this.cancelPending();
  }
  forget() {
    this.disconnect();
    this.token = "";
    localStorage.removeItem(TOKEN_KEY);
  }
}
