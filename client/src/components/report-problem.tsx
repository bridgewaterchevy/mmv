import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { CheckCircle2, ExternalLink, ImagePlus, Loader2, LifeBuoy, ShieldCheck, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { apiJson, errorStatus } from "@/lib/queryClient";
import { getLastError } from "@/lib/errorlog";
import { isStandalone } from "@/lib/invite";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Drawer, DrawerContent, DrawerDescription, DrawerHeader, DrawerTitle } from "@/components/ui/drawer";

// ---------- open/close bus ----------
// The sheet is mounted once (ReportProblemHost in App). Any button anywhere calls openReportProblem().
const OPEN_EVENT = "mmv:report-problem";

export function openReportProblem(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(OPEN_EVENT));
}

/** Mount once near the app root; listens for openReportProblem() and renders the sheet. */
export function ReportProblemHost() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const on = () => setOpen(true);
    window.addEventListener(OPEN_EVENT, on);
    return () => window.removeEventListener(OPEN_EVENT, on);
  }, []);
  return <ReportProblemDrawer open={open} onOpenChange={setOpen} />;
}

// ---------- context ----------
const MAX_MESSAGE = 2000;
const MAX_SCREENSHOT_BYTES = 5 * 1024 * 1024;
const RATE_LIMIT_MESSAGE = "Too many reports in the last hour; try again later";

export const APP_VERSION: string = (import.meta.env.VITE_APP_VERSION as string | undefined) || "dev";

function captureContext() {
  return {
    page: window.location.hash || "#/",
    userAgent: `${navigator.userAgent}${isStandalone() ? " [standalone]" : ""}`,
    appVersion: APP_VERSION,
    lastError: getLastError(),
  };
}

interface FeedbackResponse {
  id: string | number;
  githubIssueUrl?: string | null;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// ---------- the sheet ----------
export function ReportProblemDrawer({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { toast } = useToast();
  const [message, setMessage] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<FeedbackResponse | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Revoke object URLs so a long session doesn't leak memory.
  useEffect(() => {
    if (!file) {
      setPreview(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  // Fresh form every time the sheet opens.
  useEffect(() => {
    if (open) return;
    const t = setTimeout(() => {
      setMessage("");
      setFile(null);
      setError(null);
      setDone(null);
      setSending(false);
    }, 300);
    return () => clearTimeout(t);
  }, [open]);

  function pickFile(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0] ?? null;
    e.target.value = "";
    if (!f) return;
    if (!f.type.startsWith("image/")) {
      setError("That file isn't an image. Screenshots from Photos work best.");
      return;
    }
    if (f.size > MAX_SCREENSHOT_BYTES) {
      setError("That image is over the 5 MB limit. Try a smaller or cropped screenshot.");
      return;
    }
    setError(null);
    setFile(f);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    const text = message.trim();
    if (!text || sending) return;
    setSending(true);
    setError(null);
    try {
      const ctx = captureContext();
      const form = new FormData();
      form.append("message", text.slice(0, MAX_MESSAGE));
      form.append("page", ctx.page);
      form.append("userAgent", ctx.userAgent);
      form.append("appVersion", ctx.appVersion);
      form.append("lastError", ctx.lastError);
      if (file) form.append("screenshot", file, file.name || "screenshot.png");
      const res = await apiJson<FeedbackResponse>("POST", "/api/feedback", form);
      setDone(res && typeof res === "object" ? res : { id: "" });
    } catch (err) {
      const status = errorStatus(err);
      const msg = status === 429 ? RATE_LIMIT_MESSAGE : status === 413 ? "That screenshot is too large. Try one under 5 MB." : "Couldn't send that. Check your connection and try again.";
      setError(msg);
      toast({ title: msg, variant: "destructive" });
    } finally {
      setSending(false);
    }
  }

  const canSend = message.trim().length > 0 && !sending;

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent className="mx-auto max-h-[92dvh] max-w-md" data-testid="sheet-report-problem">
        <div className="overflow-y-auto px-4 pb-[calc(env(safe-area-inset-bottom,0px)+1.5rem)]">
          {done ? (
            <div className="flex flex-col items-center px-2 pb-2 pt-6 text-center" data-testid="state-report-success">
              <span className="mb-3 flex h-14 w-14 items-center justify-center rounded-full bg-accent text-accent-foreground">
                <CheckCircle2 className="h-7 w-7" strokeWidth={2.2} />
              </span>
              <DrawerTitle className="font-display text-xl">Thanks — we got it</DrawerTitle>
              <DrawerDescription className="mt-1.5">
                {done.id ? (
                  <>
                    Report <span className="font-mono font-semibold text-foreground" data-testid="text-report-id">#{String(done.id)}</span>. We read every one.
                  </>
                ) : (
                  "We read every one."
                )}
              </DrawerDescription>
              {done.githubIssueUrl && (
                <a
                  href={done.githubIssueUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-3 inline-flex items-center gap-1.5 text-sm font-semibold text-primary underline-offset-4 hover:underline"
                  data-testid="link-track-report"
                >
                  Track it <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                </a>
              )}
              <Button className="mt-6 w-full" onClick={() => onOpenChange(false)} data-testid="button-report-done">
                Done
              </Button>
            </div>
          ) : (
            <form onSubmit={submit} noValidate>
              <DrawerHeader className="px-0 text-left">
                <DrawerTitle className="flex items-center gap-2 font-display text-xl">
                  <LifeBuoy className="h-5 w-5 text-primary" aria-hidden /> Report a problem
                </DrawerTitle>
                <DrawerDescription>Something broken or confusing? Tell us and we'll fix it.</DrawerDescription>
              </DrawerHeader>

              <div className="space-y-4">
                <div>
                  <div className="mb-1.5 flex items-baseline justify-between">
                    <Label htmlFor="report-message" className="text-sm font-semibold">
                      What happened?
                    </Label>
                    <span className={cn("text-[11px] tabular-nums", message.length > MAX_MESSAGE - 100 ? "text-destructive" : "text-muted-foreground")} aria-live="polite">
                      {message.length}/{MAX_MESSAGE}
                    </span>
                  </div>
                  <Textarea
                    id="report-message"
                    value={message}
                    onChange={(e) => setMessage(e.target.value.slice(0, MAX_MESSAGE))}
                    placeholder="e.g. I tapped Lock on my pick and the spinner never stopped."
                    rows={4}
                    maxLength={MAX_MESSAGE}
                    required
                    autoComplete="off"
                    className="min-h-[104px] resize-none rounded-2xl bg-card"
                    data-testid="input-report-message"
                  />
                </div>

                <div>
                  <input
                    ref={fileRef}
                    type="file"
                    accept="image/*"
                    className="sr-only"
                    onChange={pickFile}
                    tabIndex={-1}
                    aria-hidden
                    data-testid="input-report-screenshot"
                  />
                  {file && preview ? (
                    <div className="flex items-center gap-3 rounded-2xl border border-card-border bg-card p-2 pr-3" data-testid="preview-report-screenshot">
                      <img src={preview} alt="Screenshot preview" className="h-16 w-16 shrink-0 rounded-xl object-cover" data-testid="img-report-screenshot" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{file.name || "Screenshot"}</p>
                        <p className="text-xs text-muted-foreground">{formatBytes(file.size)}</p>
                        <button type="button" className="mt-0.5 text-xs font-medium text-primary" onClick={() => fileRef.current?.click()} data-testid="button-replace-screenshot">
                          Choose another
                        </button>
                      </div>
                      <button
                        type="button"
                        onClick={() => setFile(null)}
                        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted-foreground hover-elevate"
                        aria-label="Remove screenshot"
                        data-testid="button-remove-screenshot"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => fileRef.current?.click()}
                      className="flex w-full items-center gap-3 rounded-2xl border border-dashed border-border bg-card/60 p-3 text-left hover-elevate"
                      data-testid="button-add-screenshot"
                    >
                      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-secondary text-foreground">
                        <ImagePlus className="h-5 w-5" strokeWidth={1.8} />
                      </span>
                      <span className="min-w-0">
                        <span className="block text-sm font-medium">Add a screenshot</span>
                        <span className="block text-xs text-muted-foreground">Optional · pick one from Photos</span>
                      </span>
                    </button>
                  )}
                </div>

                <p className="flex items-start gap-2 text-xs leading-snug text-muted-foreground" data-testid="text-report-context">
                  <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                  <span>We'll include: page, device, app version, and the last error — no photos of your picks.</span>
                </p>

                {error && (
                  <p role="alert" className="rounded-xl bg-destructive/10 px-3 py-2 text-sm text-destructive" data-testid="text-report-error">
                    {error}
                  </p>
                )}

                <Button type="submit" className="w-full" disabled={!canSend} data-testid="button-send-report">
                  {sending ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Sending…
                    </>
                  ) : (
                    "Send"
                  )}
                </Button>
              </div>
            </form>
          )}
        </div>
      </DrawerContent>
    </Drawer>
  );
}
