# Turning on live prices and affiliate links — a guide for Bryan (Mac)

MMV already shows each piece of an outfit with "Compare prices", "Amazon" and brand-site buttons. This guide switches on the next layer:

- **Live prices** in the pick drawer ("Cheapest: $48 at Lululemon", plus a "More prices" list)
- **Affiliate links**, so when someone buys through MMV, MMV earns a small commission

Everything below is **free to sign up for**. Each step ends with one value to paste into Render. Budget about 30 minutes for the sign-ups; the Amazon approval then runs in the background for weeks.

| Step | Service | What it does for MMV | Value you collect | Render variable name |
|---|---|---|---|---|
| 1 | **SerpApi** | Finds live prices (Google Shopping results) | Private API key | `SERPAPI_KEY` |
| 2 | **Sovrn Commerce** | Turns retailer links (Lululemon, Nike, Target…) into commission links | Site API key | `SOVRN_API_KEY` |
| 3 | **Amazon Associates** | Earns commission on Amazon links | Store ID / tag (looks like `yourname-20`) | `AMAZON_ASSOCIATES_TAG` |
| 4 | **Skimlinks** (optional, later) | Alternative to Sovrn once MMV has more content | — | — |

You can do these in any order. MMV works fine with none, one, or all of them set. Without `SERPAPI_KEY`, the drawer simply says "Live prices coming soon" under each piece.

---

## How to put a value into Render (you'll do this three times)

1. Go to <https://dashboard.render.com> and sign in.
2. Click the **mmv** service.
3. Click **Environment** in the left pane.
4. Find the variable name (e.g. `SERPAPI_KEY`) in the list and click **Edit**, paste the value, then save. Render redeploys the app automatically; give it a couple of minutes.
   - If the variable is not in the list yet, click **+ Add Environment Variable**, type the name exactly as shown in the table above, and paste the value. (Render's own instructions: *select the service → click Environment → under Environment Variables click + Add Environment Variable* — see [Render docs](https://render.com/docs/configure-environment-variables).)

Treat every key below like a house key: paste it into **Apple Passwords** first, then into Render. Never put it in a text message or email.

---

## Step 1 — SerpApi (live prices)

**What it is.** SerpApi runs Google Shopping searches for us and returns the results as data. MMV asks it "black high-waist 7/8 leggings lululemon" and gets back sellers, prices and thumbnails.

**Cost.** The Free plan is **$0/month for 250 searches per month**, with a throughput cap of **50 searches per hour** ([SerpApi pricing](https://serpapi.com/pricing)). MMV caps itself at 8 provider calls per day and caches results for 24 hours, so a small crew stays well inside 250.

**Sign up.**

1. Open <https://serpapi.com/users/sign_up> (or click **Get Started** under the Free plan on the [pricing page](https://serpapi.com/pricing)). You can sign up with Google, GitHub, or an email + password.
2. Confirm your email if asked.

**Find the key.**

1. Once signed in, go to <https://serpapi.com/manage-api-key>. This is the "Manage API Key" page of your dashboard — the long string labelled **"Your Private API Key"** is what you need ([SerpApi: connecting the MCP server](https://serpapi.com/blog/how-to-connect-serpapi-mcp-to-claude-desktop/)).
2. Click the copy icon next to it. If you ever paste it somewhere public by accident, press **Regenerate API Key** on the same page and update Render ([SerpApi blog](https://serpapi.com/blog/scrape-google-jobs-to-easily-make-job-lists-using-serpapi/)).

**Put it in Render:** variable **`SERPAPI_KEY`**.

**Check it worked.** Open MMV, tap any pick, and look under "Shop the pieces". Within a few seconds each piece should show a pink "Cheapest: $… at …" row with a **Buy** button. (The very first lookup for an outfit is the slow one; after that it is cached.)

---

## Step 2 — Sovrn Commerce (commission on retailer links)

**What it is.** Sovrn Commerce (formerly VigLink) is an affiliate network that covers thousands of retailers at once. When `SOVRN_API_KEY` is set, MMV wraps every non-Amazon "Buy" link so that Sovrn credits MMV if the shopper buys. If a retailer isn't in Sovrn's network, the link just goes straight through.

**Sign up.**

1. Go to <https://platform.sovrn.com/account/signup>. You can use an email + password or your Google account ([Sovrn: getting started guide](https://knowledge.sovrn.com/kb/general-guide-for-getting-started-with-commerce)).
2. On the Welcome page click **Get started** under **Commerce**, then **Apply now** ([Sovrn: getting approved](https://www.sovrn.com/blog/getting-approved-for-commerce/)).
3. Under "Where do you post?", choose **Website** and enter the full live address: `https://mmv-uhw1.onrender.com`. Sovrn asks for complete, specific URLs rather than shortened links ([Sovrn: getting approved](https://www.sovrn.com/blog/getting-approved-for-commerce/)).
4. Read and accept the Commerce terms and conditions.

**How approval works (this is the unusual part).** Sovrn does *not* approve you on the spot. Its Network Quality team reviews a site only **after** your Sovrn links have generated at least one real click — ideally several — from real humans; the system follows the links and checks where the traffic came from ([Sovrn: getting approved](https://www.sovrn.com/blog/getting-approved-for-commerce/)). So the order is:

1. Get your key (below) and put it into Render **first**.
2. Open MMV on your phone and tap a few **Buy** buttons for non-Amazon stores. Ask a crew member to do the same. Those clicks trigger the review.
3. Wait for an approval email. Sovrn says the review **may take up to 5 business days** and the email can land in spam ([Sovrn: getting started guide](https://knowledge.sovrn.com/kb/general-guide-for-getting-started-with-commerce)).

Until approval, the links still work for shoppers — they just don't earn anything yet.

**Find the key.**

1. In the Sovrn platform, open **Settings** (direct link: <https://platform.sovrn.com/commerce/settings/site>).
2. In the row for your site, under **Actions**, click the **Key** icon. The pop-up shows the site's **API key** ([Sovrn: API implementation](https://knowledge.sovrn.com/kb/api-implementation-with-commerce)).
3. Copy the **API key** (not the "Secret key" — that one is for pulling reports and should never be shared).

**Put it in Render:** variable **`SOVRN_API_KEY`**.

**The FTC disclosure (required, already built in).** The US Federal Trade Commission requires anyone using affiliate links to tell readers they may be paid, and Sovrn requires that disclosure on every page that carries an affiliate link — clearly worded, visible without scrolling past the links, and *not* hidden only in a Terms or About page ([Sovrn: disclosure statements](https://knowledge.sovrn.com/kb/sovrn-commerce-disclosure-statements)). The FTC's own example wording is "I get commissions for purchases made through links in this post," and it warns that a bare "Buy now" button or the phrase "affiliate link" on its own is not enough ([FTC Endorsement Guides FAQ](https://www.ftc.gov/system/files/documents/plain-language/pdf-0205-endorsement-guides-faqs_0.pdf)).

MMV already does this: every pick drawer shows **"Affiliate links may earn MMV a commission, at no extra cost to you."** directly under the shop cards, next to the Buy buttons. If Sovrn's team asks you for a "disclosure form" during review, that sentence and its position are what you describe.

---

## Step 3 — Amazon Associates (commission on Amazon links)

**What it is.** Amazon's own affiliate program. Once you have a Store ID, MMV adds `?tag=yourid-20` to every Amazon link so Amazon credits MMV for purchases.

**Sign up.**

1. Go to <https://affiliate-program.amazon.com/> and click **Sign up** (top right). Sign in with your normal Amazon account or create one.
2. When asked for your website or mobile app, enter the live site exactly: `https://mmv-uhw1.onrender.com`. Amazon reviews every site listed in the application, so list only this one ([Amazon: application review process](https://affiliate-program.amazon.com/help/node/topic/G8TW5AE9XL2VX9VM)).
3. Pick a Store ID when prompted. Something like `matchmyvibe` is fine; Amazon automatically adds **`-20`** to the end, so your tag becomes `matchmyvibe-20` ([Amazon: Associate IDs](https://affiliate-program.amazon.com/help/node/topic/GM6CHU93RDXZV7D8)).
4. Describe the site honestly: "An app where friends share outfit photos and get links to shop the pieces."

**The 3-sales-in-180-days rule.** Amazon doesn't really review the application at sign-up. You get a working Store ID right away, and then you have **180 days to refer at least three qualifying sales**; Amazon evaluates the application within a day or two of the third sale. If three sales don't happen within 180 days the application is withdrawn, and a rejected account can't be reinstated — you'd have to apply again later ([Amazon: 180 days to refer a sale](https://affiliate-program.amazon.com/help/node/topic/G7MJTPEP9NC3YKMG)). Two things to know:

- **Your own purchases do not count** ("personal orders do not qualify") ([Amazon: application review process](https://affiliate-program.amazon.com/help/node/topic/G8TW5AE9XL2VX9VM)).
- When Amazon does review, it wants to see a site with "robust original content" that is publicly reachable — their rule of thumb is at least 10 posts, with something recent in the last 60 days ([Amazon: application review process](https://affiliate-program.amazon.com/help/node/topic/G8TW5AE9XL2VX9VM)). MMV's crew pages are behind a login, so a public landing page describing MMV (with a few outfit examples) before you apply will help. If you're not ready, do Steps 1 and 2 now and come back to Amazon later — nothing else depends on it.

**Find the Store ID / tag.** After sign-up, your Store ID appears at the **top right of Associates Central** whenever you're logged in ([Amazon: Store IDs](https://affiliate-program.amazon.com/help/node/topic/GPW5YCEUHGH83SMD)). Amazon also calls this a "tracking ID"; it's the value that appears as `&tag=…` in any Amazon link you create ([Amazon: checking your links](https://affiliate-program.amazon.com/help/node/topic/G6253GFSARDQENZR)). Ignore any extra ID that begins with `onamz` — that one is for content you post on Amazon itself ([Amazon: Store IDs](https://affiliate-program.amazon.com/help/node/topic/GPW5YCEUHGH83SMD)).

**Put it in Render:** variable **`AMAZON_ASSOCIATES_TAG`**, value like `matchmyvibe-20`.

**Why MMV says "See price on Amazon" instead of showing an Amazon price.** Amazon's Program Policies say a site "may only show prices and availability if: (a) we serve the link in which that price and availability data are displayed, or (b) you obtain Product pricing and availability data via Creators API or PA API" and follow that API's licence, with cached data refreshed at least every 24 hours ([Amazon Associates Program Policies](https://affiliate-program.amazon.com/help/operating/policies)). Access to that API requires an open Associates account that is following the Operating Agreement, plus a separate application for the Product Advertising API ([Amazon: PA-API requirements](https://affiliate-program.amazon.com/help/node/topic/GVJ2BJP35457CLML)). Prices we find through SerpApi don't come from Amazon's API, so showing them for Amazon listings would break the rules. MMV therefore lists Amazon offers with the label **"See price on Amazon"** and no number. This is deliberate — don't "fix" it.

**One more required sentence.** Amazon's Operating Agreement requires the statement **"As an Amazon Associate I earn from qualifying purchases."** to appear clearly on the site ([Amazon: identifying yourself as an Associate](https://affiliate-program.amazon.com/help/node/topic/GHQNZAU6669EZS98)). Once your tag is live, ask whoever is maintaining the code to add that sentence to the drawer disclosure (e.g. "Affiliate links may earn MMV a commission. As an Amazon Associate, MMV earns from qualifying purchases."). It's a one-line change.

---

## Step 4 — Skimlinks (an alternative to Sovrn, for later)

Skimlinks does the same job as Sovrn Commerce (one account covering many retailers). Reasons you might switch or add it later: a merchant you care about is on Skimlinks but not Sovrn, or Sovrn declines MMV.

- **Sign up:** <https://www.skimlinks.com/signup/> — a form with your contact details and site URL ([Skimlinks: how do I join](https://support.skimlinks.com/hc/en-us/articles/360025011673-How-do-I-join-Skimlinks-as-a-Publisher)).
- **Approval:** a human on their approvals team reviews the site and emails a decision within **2 business days** (add `noreply@skimlinks.com` to your safe senders) ([Skimlinks: how do I join](https://support.skimlinks.com/hc/en-us/articles/360025011673-How-do-I-join-Skimlinks-as-a-Publisher)).
- **Why "later":** Skimlinks wants a live site with enough content to see what it's about, with links to merchants, and is optimised for editorial sites and blogs; it does not work with mobile apps or downloadable software, and the team may ask for proof you own the site ([Skimlinks: why was I denied](https://support.skimlinks.com/hc/en-us/articles/223835548-Why-was-I-denied)). A public MMV landing page with real outfit content makes approval much more likely. Skimlinks is not wired into the code yet, so if you get approved, tell whoever maintains the code and they'll add a `SKIMLINKS_…` setting alongside the Sovrn one.

---

## Quick checklist

- [ ] SerpApi account created → key copied from <https://serpapi.com/manage-api-key> → Render `SERPAPI_KEY`
- [ ] Sovrn account created, site `https://mmv-uhw1.onrender.com` submitted → API key from Settings → Key icon → Render `SOVRN_API_KEY`
- [ ] Tapped a few Buy buttons so Sovrn's review starts; watched for the approval email (up to 5 business days)
- [ ] Amazon Associates applied with the live URL → Store ID (`…-20`) → Render `AMAZON_ASSOCIATES_TAG`
- [ ] Calendar reminder: 3 real Amazon sales needed within 180 days of applying
- [ ] "As an Amazon Associate…" sentence added to the drawer disclosure once the tag is live
- [ ] (Later) Skimlinks if Sovrn says no or a key retailer is missing

## If something looks wrong

| What you see | Likely cause | What to do |
|---|---|---|
| "Live prices coming soon" under every piece | `SERPAPI_KEY` missing, or the daily lookup budget (8/day) is spent, or SerpApi's 250/month is used up | Check the Render variable; otherwise wait until tomorrow / next month. The links still work. |
| Prices show, but Amazon rows say "See price on Amazon" | Expected — see Step 3 | Nothing. |
| Sovrn still "pending" after a week | No real clicks reached their links yet | Tap a few Buy buttons on non-Amazon stores from different phones; check spam for their email. |
| Amazon application "withdrawn" | Fewer than 3 qualifying sales in 180 days | Build up the public landing page, then apply again. |
