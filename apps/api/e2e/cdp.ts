// Minimal Playwright-style page driver over the Chrome DevTools Protocol.
// No new npm dependency: uses Node 24's global WebSocket and a locally
// installed Chrome/Chromium (CHROME_BIN). Local, headless, no network calls
// beyond the loopback web server under test.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void };

export class Browser {
  private constructor(private proc: ChildProcess, private dir: string, private wsUrl: string) {}
  static async launch(): Promise<Browser> {
    const bin = process.env.CHROME_BIN ?? "google-chrome";
    const dir = mkdtempSync(path.join(tmpdir(), "ae-e2e-chrome-"));
    const proc = spawn(bin, [
      "--headless=new", "--no-sandbox", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
      "--disable-background-networking", "--disable-sync", "--disable-extensions", "--metrics-recording-only",
      "--remote-debugging-port=0", `--user-data-dir=${dir}`, "about:blank",
    ], { stdio: "ignore" });
    const portFile = path.join(dir, "DevToolsActivePort");
    for (let i = 0; i < 200 && !existsSync(portFile); i++) await new Promise((r) => setTimeout(r, 50));
    if (!existsSync(portFile)) throw new Error("chrome did not start (no DevToolsActivePort)");
    const [port] = readFileSync(portFile, "utf8").split("\n");
    const list = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as Array<{ type: string; webSocketDebuggerUrl: string }>;
    const pageTarget = list.find((t) => t.type === "page");
    if (!pageTarget) throw new Error("no page target");
    return new Browser(proc, dir, pageTarget.webSocketDebuggerUrl);
  }
  async newPage(): Promise<Page> {
    const page = new Page(this.wsUrl);
    await page.open();
    return page;
  }
  async close() {
    this.proc.kill("SIGKILL");
    try { rmSync(this.dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

export class Page {
  private ws!: WebSocket;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  readonly consoleErrors: string[] = [];
  constructor(private wsUrl: string) {}
  async open() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise<void>((res, rej) => { this.ws.onopen = () => res(); this.ws.onerror = () => rej(new Error("cdp ws error")); });
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message)); else p.resolve(msg.result);
      } else if (msg.method === "Runtime.exceptionThrown") {
        this.consoleErrors.push(msg.params.exceptionDetails?.exception?.description ?? "exception");
      }
    };
    await this.send("Page.enable");
    await this.send("Runtime.enable");
  }
  send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  async evaluate<T>(expression: string): Promise<T> {
    const r = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`evaluate failed: ${r.exceptionDetails.text}`);
    return r.result.value as T;
  }
  async goto(url: string) {
    await this.send("Page.navigate", { url });
    await this.waitFor(() => this.evaluate<boolean>("document.readyState === 'complete'"), `load ${url}`);
  }
  async url(): Promise<string> { return this.evaluate<string>("location.pathname + location.search"); }
  async text(): Promise<string> { return this.evaluate<string>("document.body ? document.body.innerText : ''"); }
  async waitForText(needle: string, timeoutMs = 20000) {
    await this.waitFor(async () => (await this.text()).includes(needle), `text "${needle}"`, timeoutMs);
  }
  /** Click the first visible link/button/tab whose trimmed text equals `label`. */
  async clickText(label: string) {
    const ok = await this.evaluate<boolean>(`(() => {
      const els = [...document.querySelectorAll('a,button,[role=tab]')];
      const el = els.find((e) => (e.textContent || '').trim() === ${JSON.stringify(label)} && e.offsetParent !== null);
      if (!el) return false; el.click(); return true; })()`);
    if (!ok) throw new Error(`no clickable element with text "${label}"`);
  }
  async waitFor(fn: () => Promise<boolean>, what: string, timeoutMs = 20000) {
    const end = Date.now() + timeoutMs;
    let last: unknown;
    while (Date.now() < end) {
      try { if (await fn()) return; } catch (e) { last = e; }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`timed out waiting for ${what}${last ? `: ${String(last)}` : ""}`);
  }
  close() { this.ws.close(); }
}
