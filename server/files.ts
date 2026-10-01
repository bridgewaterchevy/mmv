import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { Express } from "express";
import express from "express";

/**
 * Photo storage abstraction.
 *
 * - SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY set -> objects go to a public Supabase
 *   Storage bucket (SUPABASE_BUCKET, default "outfits"); photoPath is the absolute
 *   public URL of the object.
 * - otherwise -> files are written to ./uploads and served from /uploads (local dev).
 */
export interface FileStore {
  readonly kind: "supabase" | "local";
  init(app: Express): Promise<void>;
  /** Persist an image; returns the photoPath to store on the pick. */
  put(buffer: Buffer, ext: string, mime: string): Promise<string>;
  /** Best-effort delete of a previously stored photoPath. Never throws. */
  remove(photoPath: string): Promise<void>;
}

export const UPLOAD_DIR = path.resolve("uploads");

function objectName(ext: string) {
  return `${Date.now()}-${randomBytes(8).toString("hex")}${ext}`;
}

class LocalStore implements FileStore {
  readonly kind = "local" as const;
  async init(app: Express) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    app.use(
      "/uploads",
      express.static(UPLOAD_DIR, {
        maxAge: "7d",
        index: false,
        dotfiles: "deny",
        setHeaders: (res) => {
          res.setHeader("X-Content-Type-Options", "nosniff");
          res.setHeader("Content-Disposition", "inline");
          res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
        },
      }),
    );
    // Missing/removed photos should 404 instead of falling through to the SPA index.
    app.use("/uploads", (_req, res) => res.status(404).end());
    console.log(`[files] local uploads at ${UPLOAD_DIR}`);
  }
  async put(buffer: Buffer, ext: string) {
    const name = objectName(ext);
    await fs.promises.writeFile(path.join(UPLOAD_DIR, name), buffer);
    return `/uploads/${name}`;
  }
  async remove(photoPath: string) {
    if (!photoPath.startsWith("/uploads/")) return;
    const file = path.join(UPLOAD_DIR, path.basename(photoPath));
    await fs.promises.rm(file, { force: true }).catch(() => {});
  }
}

class SupabaseStore implements FileStore {
  readonly kind = "supabase" as const;
  private client: import("@supabase/supabase-js").SupabaseClient | null = null;
  constructor(
    private url: string,
    private key: string,
    private bucket: string,
  ) {}

  private async sb() {
    if (!this.client) {
      const { createClient } = await import("@supabase/supabase-js");
      // supabase-js constructs a Realtime client eagerly and throws on Node < 22 (no global WebSocket);
      // we never use Realtime, but hand it the `ws` package so createClient works on any Node version.
      const ws = (await import("ws")).default;
      this.client = createClient(this.url, this.key, {
        auth: { persistSession: false, autoRefreshToken: false },
        realtime: { transport: ws as unknown as NonNullable<NonNullable<Parameters<typeof createClient>[2]>["realtime"]>["transport"] },
      });
    }
    return this.client;
  }

  async init(_app: Express) {
    const sb = await this.sb();
    const { data: buckets, error } = await sb.storage.listBuckets();
    if (error) {
      // Don't crash-loop on a transient Supabase hiccup; uploads will surface the error per request.
      console.error(`[files] cannot list Supabase buckets (check SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY): ${error.message}`);
      return;
    }
    if (!buckets?.some((b) => b.name === this.bucket)) {
      const { error: createErr } = await sb.storage.createBucket(this.bucket, {
        public: true,
        fileSizeLimit: 12 * 1024 * 1024,
        allowedMimeTypes: ["image/jpeg", "image/png", "image/webp", "image/gif", "image/heic", "image/heif"],
      });
      if (createErr && !/already exists/i.test(createErr.message)) throw new Error(`[files] cannot create bucket "${this.bucket}": ${createErr.message}`);
      console.log(`[files] created public Supabase bucket "${this.bucket}"`);
    }
    console.log(`[files] Supabase Storage bucket "${this.bucket}"`);
  }

  async put(buffer: Buffer, ext: string, mime: string) {
    const sb = await this.sb();
    const name = objectName(ext);
    const { error } = await sb.storage.from(this.bucket).upload(name, buffer, { contentType: mime, cacheControl: "604800", upsert: false });
    if (error) throw new Error(`Photo upload failed: ${error.message}`);
    return sb.storage.from(this.bucket).getPublicUrl(name).data.publicUrl;
  }

  async remove(photoPath: string) {
    const name = this.objectFromUrl(photoPath);
    if (!name) return;
    const sb = await this.sb();
    const { error } = await sb.storage.from(this.bucket).remove([name]);
    if (error) console.error("[files] remove failed", error.message);
  }

  private objectFromUrl(photoPath: string): string | null {
    // https://<proj>.supabase.co/storage/v1/object/public/<bucket>/<name>
    const marker = `/object/public/${this.bucket}/`;
    const i = photoPath.indexOf(marker);
    if (i === -1) return null;
    return decodeURIComponent(photoPath.slice(i + marker.length).split("?")[0]);
  }
}

export function createFileStore(): FileStore {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (url && key) return new SupabaseStore(url, key, process.env.SUPABASE_BUCKET || "outfits");
  return new LocalStore();
}

export const files: FileStore = createFileStore();

/** Delete a stored photo (works for both local paths and Supabase public URLs). */
export async function removeUpload(photoPath: string) {
  await files.remove(photoPath);
}
