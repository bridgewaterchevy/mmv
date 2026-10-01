import { pgTable, text, integer, serial, boolean, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import type * as z from "zod/mini";

// ---------- Users ----------
export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  handle: text("handle").notNull().unique(),
  pin: text("pin").notNull(),
  color: text("color").notNull(), // avatar hue as hex
  token: text("token").notNull().unique(),
});
export const insertUserSchema = createInsertSchema(users).pick({
  name: true,
  handle: true,
  pin: true,
});
export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;
export type PublicUser = Omit<User, "pin" | "token">;

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
export interface GarmentItem {
  category: string; // "sports bra", "leggings", "shoes"
  description: string; // "black high-waist 7/8 leggings"
  colorName: string;
  colorHex: string;
  brandGuess: string | null;
  searchQuery: string;
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
