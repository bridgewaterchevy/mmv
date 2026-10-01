import { useRef, useState, type ChangeEvent, type ReactNode } from "react";
import { Camera, Images } from "lucide-react";
import { cn } from "@/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

/**
 * Two-source photo picker. iOS Safari treats `capture="environment"` as camera-only and never
 * offers the photo library, so we keep TWO hidden inputs — one with capture (camera) and one
 * without (library) — and let the user choose from a tiny popover anchored to whatever trigger
 * is passed as children. Desktop has no camera sheet, so both routes end up in the OS file picker.
 *
 * HEIC/HEIF (or an empty `file.type`) is passed through untouched; the server sniffs the bytes
 * and decides. Callers surface a friendly message on a 400.
 *
 * The library input accepts several files at once (`multiple`); the camera input is always a
 * single shot. Either way the caller receives `File[]`, capped at `max` when given.
 */
export function PhotoSourcePicker({
  onFiles,
  children,
  align = "center",
  side = "bottom",
  className,
  disabled = false,
  multiple = true,
  max,
  title = "Add a photo",
  testIdPrefix = "photo",
}: {
  /** Called with the chosen files (never empty). Camera gives one; library may give several. */
  onFiles: (files: File[]) => void;
  /** The tappable surface (card, button). Rendered via Radix `asChild`, so pass a single element. */
  children: ReactNode;
  align?: "start" | "center" | "end";
  side?: "top" | "bottom";
  className?: string;
  disabled?: boolean;
  /** Allow multi-select from the library (default true). The camera input is always single. */
  multiple?: boolean;
  /** Hard cap on how many files a single choice may return (extra files are dropped). */
  max?: number;
  /** Sheet heading. */
  title?: string;
  /** `input-${prefix}` stays on the camera input for back-compat; the library input is `input-${prefix}-library`. */
  testIdPrefix?: string;
}) {
  const [open, setOpen] = useState(false);
  const cameraRef = useRef<HTMLInputElement>(null);
  const libraryRef = useRef<HTMLInputElement>(null);

  function handleChange(e: ChangeEvent<HTMLInputElement>) {
    let files = Array.from(e.target.files ?? []);
    // Reset so picking the same file twice still fires onChange.
    e.target.value = "";
    if (typeof max === "number") files = files.slice(0, Math.max(0, max));
    if (files.length) onFiles(files);
  }

  function pick(ref: typeof cameraRef) {
    setOpen(false);
    // Let the popover close before the OS sheet takes over; iOS otherwise drops the click sometimes.
    requestAnimationFrame(() => ref.current?.click());
  }

  return (
    <>
      <input
        ref={cameraRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={handleChange}
        tabIndex={-1}
        aria-hidden
        data-testid={`input-${testIdPrefix}`}
      />
      <input
        ref={libraryRef}
        type="file"
        accept="image/*"
        multiple={multiple && (max === undefined || max > 1)}
        className="hidden"
        onChange={handleChange}
        tabIndex={-1}
        aria-hidden
        data-testid={`input-${testIdPrefix}-library`}
      />
      <Popover open={open && !disabled} onOpenChange={setOpen}>
        <PopoverTrigger asChild disabled={disabled}>
          {children}
        </PopoverTrigger>
        <PopoverContent
          side={side}
          align={align}
          sideOffset={8}
          collisionPadding={12}
          className={cn("w-[min(18rem,calc(100vw-2rem))] rounded-2xl border-card-border p-1.5 shadow-lg", className)}
          data-testid="sheet-photo-source"
        >
          <p className="px-2.5 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{title}</p>
          <button
            type="button"
            onClick={() => pick(cameraRef)}
            className="flex w-full items-center gap-3 rounded-xl px-2.5 py-2.5 text-left text-sm font-medium hover-elevate"
            data-testid="button-photo-camera"
          >
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">
              <Camera className="h-4 w-4" aria-hidden />
            </span>
            <span className="min-w-0">
              <span className="block">Take a photo</span>
              <span className="block text-xs font-normal text-muted-foreground">Opens the camera</span>
            </span>
          </button>
          <button
            type="button"
            onClick={() => pick(libraryRef)}
            className="flex w-full items-center gap-3 rounded-xl px-2.5 py-2.5 text-left text-sm font-medium hover-elevate"
            data-testid="button-photo-library"
          >
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-secondary text-foreground">
              <Images className="h-4 w-4" aria-hidden />
            </span>
            <span className="min-w-0">
              <span className="block">Choose from library</span>
              <span className="block text-xs font-normal text-muted-foreground">{multiple && (max === undefined || max > 1) ? "Pick one or several" : "Camera roll, screenshots, Files"}</span>
            </span>
          </button>
        </PopoverContent>
      </Popover>
    </>
  );
}

/** Friendly copy for a server 400 on a photo upload (typically an unsupported container like some HEIF variants). */
export const UNSUPPORTED_PHOTO_MESSAGE = "That photo format isn't supported yet — try a screenshot of it or a JPEG";
