import { pgTable, text, integer, serial, boolean, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import type * as z from "zod/mini";
import { z as zod } from "zod";

// ---------- Users ----------
/**
 * Which department a user shops in. Used as a hint on shopping price queries (server/prices.ts
 * buildShoppingQuery): "womens" → "women's <query>", "mens" → "men's <query>", "unisex" → no hint
 * (fall back to the garment's vision `fit`), null → unknown (also falls back to `fit`).
 */
export const SHOP_FOR = ["womens", "mens", "unisex"] as const;
export type ShopFor = (typeof SHOP_FOR)[number];

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  handle: text("handle").notNull().unique(),
  pin: text("pin").notNull(),
  color: text("color").notNull(), // avatar hue as hex
  token: text("token").notNull().unique(),
  shopFor: text("shop_for").$type<ShopFor>(), // nullable; see SHOP_FOR
});
export const insertUserSchema = createInsertSchema(users).pick({
  name: true,
  handle: true,
  pin: true,
});
export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;
/** `isAdmin` is only present on GET /api/me (handle listed in ADMIN_HANDLES); other user payloads omit it. */
export type PublicUser = Omit<User, "pin" | "token"> & { isAdmin?: boolean };

// ---------- Crews (groups) ----------
export const ACTIVITIES = [
  // going out
  "Date night",
  "Girls' night",
  "Guys' night",
  "Brunch",
  "Concert",
  "Game day",
  "Wedding guests",
  "Trip",
  "Work",
  // sweat
  "CrossFit",
  "Gym",
  "Run club",
  "Pickleball",
  "Tennis",
  "Yoga / Pilates",
  "Cycling",
  "Golf",
  "Other",
] as const;

export const ACTIVITY_GROUPS: { label: string; items: Activity[] }[] = [
  { label: "Going out", items: ["Date night", "Girls' night", "Guys' night", "Brunch", "Concert", "Game day", "Wedding guests", "Trip", "Work"] },
  { label: "Sweat", items: ["CrossFit", "Gym", "Run club", "Pickleball", "Tennis", "Yoga / Pilates", "Cycling", "Golf"] },
  { label: "Anything else", items: ["Other"] },
];

export const ACTIVITY_ICON: Record<Activity, string> = {
  "Date night": "🍷", "Girls' night": "💃", "Guys' night": "🍻", Brunch: "🥂", Concert: "🎤", "Game day": "🏈", "Wedding guests": "💍", Trip: "✈️", Work: "💼",
  CrossFit: "🏋️", Gym: "💪", "Run club": "🏃‍♀️", Pickleball: "🥒", Tennis: "🎾", "Yoga / Pilates": "🧘‍♀️", Cycling: "🚴‍♀️", Golf: "⛳", Other: "✨",
};
export type Activity = (typeof ACTIVITIES)[number];

export const crews = pgTable("crews", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  activity: text("activity").notNull(),
  inviteCode: text("invite_code").notNull().unique(),
  createdBy: integer("created_by").notNull(),
});
export const insertCrewSchema = createInsertSchema(crews).pick({
  name: true,
  activity: true,
});
export type InsertCrew = z.infer<typeof insertCrewSchema>;
export type Crew = typeof crews.$inferSelect;

export const crewMembers = pgTable("crew_members", {
  id: serial("id").primaryKey(),
  crewId: integer("crew_id").notNull(),
  userId: integer("user_id").notNull(),
});
export type CrewMember = typeof crewMembers.$inferSelect;

// ---------- Sessions (a dated "what are we wearing" plan) ----------
export const sessions = pgTable("sessions", {
  id: serial("id").primaryKey(),
  crewId: integer("crew_id").notNull(),
  title: text("title").notNull(), // "6am WOD", "Saturday doubles"
  date: text("date").notNull(), // YYYY-MM-DD
  vibe: text("vibe"), // optional theme: "all black", "neon", "pink & grey"
  createdBy: integer("created_by").notNull(),
});
export const insertSessionSchema = createInsertSchema(sessions).pick({
  crewId: true,
  title: true,
  date: true,
  vibe: true,
});
export type InsertSession = z.infer<typeof insertSessionSchema>;
export type Session = typeof sessions.$inferSelect;

// ---------- Picks (one member's outfit for a session) ----------
/** Apparent target department of a garment, guessed by vision from style cues. Same values as ShopFor. */
export const GARMENT_FITS = SHOP_FOR;
export type GarmentFit = ShopFor;

export interface GarmentItem {
  category: string; // "sports bra", "leggings", "shoes"
  description: string; // "black high-waist 7/8 leggings"
  colorName: string;
  colorHex: string;
  brandGuess: string | null;
  searchQuery: string;
  /**
   * Vision's guess at the department the piece is sold in ("womens" | "mens" | "unisex").
   * Optional: picks analysed before this field existed have no `fit` and are treated as "unisex".
   */
  fit?: GarmentFit;
  /**
   * The query actually used for price lookups and the Compare prices / Amazon links, i.e. searchQuery
   * with a "women's " / "men's " prefix when the pick owner's shopFor (or `fit`) says so. Computed at
   * read time (server/prices.ts buildShoppingQuery); never stored.
   */
  shoppingQuery?: string;
  links: { label: string; url: string }[];
}

export const picks = pgTable("picks", {
  id: serial("id").primaryKey(),
  sessionId: integer("session_id").notNull(),
  userId: integer("user_id").notNull(),
  photoPath: text("photo_path").notNull(),
  note: text("note"),
  palette: text("palette").notNull().default("[]"), // JSON string[] of hex
  items: text("items").notNull().default("[]"), // JSON GarmentItem[]
  locked: boolean("locked").notNull().default(false),
  createdAt: text("created_at").notNull(),
});
export type Pick = typeof picks.$inferSelect;
export interface PickView extends Omit<Pick, "palette" | "items"> {
  palette: string[];
  items: GarmentItem[];
  user: PublicUser;
  reactions: ReactionView[];
}

// ---------- Reactions (emoji or short comment on a pick) ----------
export const reactions = pgTable("reactions", {
  id: serial("id").primaryKey(),
  pickId: integer("pick_id").notNull(),
  userId: integer("user_id").notNull(),
  emoji: text("emoji"),
  comment: text("comment"),
});
export const insertReactionSchema = createInsertSchema(reactions).pick({
  pickId: true,
  emoji: true,
  comment: true,
});
export type InsertReaction = z.infer<typeof insertReactionSchema>;
export type Reaction = typeof reactions.$inferSelect;
export interface ReactionView extends Reaction {
  user: PublicUser;
}

// ---------- Composite views ----------
export interface CrewView extends Crew {
  members: PublicUser[];
  nextSession: (Session & { pickCount: number }) | null;
}
export interface SessionView extends Session {
  crew: Crew;
  members: PublicUser[];
  picks: PickView[];
}

// ---------- Shopping offers (lazy price lookups, see server/prices.ts) ----------
export interface Offer {
  title: string;
  seller: string; // merchant name as reported by the provider ("Walmart", "lululemon")
  /**
   * Price in USD. `null` when the merchant is Amazon: the Associates Program Policies only allow
   * showing Amazon prices served by Amazon itself or fetched through PA-API / Creators API, so we
   * hide the number and let the UI say "See price on Amazon" instead.
   */
  price: number | null;
  priceText: string; // display string from the provider ("$92.00") or "See price on Amazon"
  url: string; // already affiliate-wrapped when the matching key is configured
  /**
   * true when `url` points at the retailer itself (host is not google.*). false for Google Shopping
   * product pages / searches, which are what SerpApi returns when no merchant `link` is available
   * and the Immersive Product fallback could not resolve one (see server/prices.ts).
   */
  direct: boolean;
  /** Retailer hostname without "www." ("lululemon.com"), computed from the url BEFORE affiliate wrapping. "" when unknown. */
  retailerHost: string;
  thumbnail?: string;
  source: "serpapi" | "hasdata";
  /** SerpApi `immersive_product_page_token`; kept in price_cache so a later resolve needs no new search. Stripped from API responses. */
  immersiveToken?: string;
}

/** One entry of GET /api/picks/:id/prices → { items: PricedItem[] } */
export interface PricedItem extends GarmentItem {
  offers: Offer[];
}

// Cache of provider results keyed by the normalised (lowercase, trimmed) search query. TTL is
// enforced in code (server/prices.ts) so stale rows can still be served when providers fail.
export const priceCache = pgTable("price_cache", {
  query: text("query").primaryKey(),
  offers: text("offers").notNull().default("[]"), // JSON Offer[] (unwrapped urls)
  fetchedAt: timestamp("fetched_at", { withTimezone: true, mode: "date" }).notNull(),
});
export type PriceCacheRow = typeof priceCache.$inferSelect;

// Provider calls per UTC day; guards the 250/month free SerpApi quota (PRICE_LOOKUPS_PER_DAY).
export const priceBudget = pgTable("price_budget", {
  day: text("day").primaryKey(), // YYYY-MM-DD (UTC)
  calls: integer("calls").notNull().default(0),
});

// ---------- Feedback ("Report a problem" / "Suggest an idea", see server/feedback.ts + server/github.ts) ----------
export const FEEDBACK_STATUSES = ["open", "resolved"] as const;
export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number];
/** "problem" = bug report (GitHub "[Report]", label user-report); "suggestion" = idea ("[Idea]", label suggestion). */
export const FEEDBACK_KINDS = ["problem", "suggestion"] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];

export const feedback = pgTable("feedback", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  kind: text("kind").$type<FeedbackKind>().notNull().default("problem"),
  message: text("message").notNull(), // 1–2000 chars
  page: text("page"), // route / URL the user was on
  userAgent: text("user_agent"),
  appVersion: text("app_version"),
  lastError: text("last_error"), // last client-side error (≤ 4000 chars)
  screenshotPath: text("screenshot_path"), // files.ts path: absolute Supabase URL or /uploads/feedback/<id>.<ext>
  githubIssueUrl: text("github_issue_url"), // html_url of the filed issue, null when filing was skipped / failed
  status: text("status").$type<FeedbackStatus>().notNull().default("open"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
});
export type Feedback = typeof feedback.$inferSelect;

/** One row of GET /api/feedback (admin); includes `kind`. `user` is null if the reporter was deleted. */
export interface FeedbackReport extends Feedback {
  user: { id: number; name: string; handle: string } | null;
}

/** Response of POST /api/feedback. */
export interface FeedbackCreated {
  id: number;
  kind: FeedbackKind;
  githubIssueUrl: string | null;
}

/**
 * Body of POST /api/feedback (JSON or multipart form fields; multipart may add an image file in
 * the `screenshot` field, ≤ 5 MB, JPG/PNG/WebP/GIF/HEIC). Empty strings are treated as "not set".
 * `kind` defaults to "problem"; anything other than "problem" | "suggestion" is a 400.
 */
export const feedbackBodySchema = zod.object({
  kind: zod.enum(FEEDBACK_KINDS, { message: 'kind must be "problem" or "suggestion"' }).default("problem"),
  message: zod.string().trim().min(1, "Tell us what went wrong").max(2000, "Keep the message under 2000 characters"),
  page: zod.string().trim().max(500).optional().nullable(),
  userAgent: zod.string().trim().max(1000).optional().nullable(),
  appVersion: zod.string().trim().max(100).optional().nullable(),
  lastError: zod.string().trim().max(4000, "lastError is limited to 4000 characters").optional().nullable(),
});
export type FeedbackBody = zod.infer<typeof feedbackBodySchema>;

/** Body of PATCH /api/feedback/:id (admin). */
export const feedbackStatusSchema = zod.object({ status: zod.enum(FEEDBACK_STATUSES) });
