# P6 — going live

Everything here is dashboard clicks plus two numbers. Verified against Cloudflare docs
2026-08-13. Written to be followed in order — later steps depend on earlier ones existing.

**Already done:** `agawen.com` is registered at Cloudflare, so the zone is live on Cloudflare
nameservers. That was the hard prerequisite, open since Aug 5, and it gated everything below.

---

## Stage 1 — the image plumbing (~10 min)

This is what turns the grey placeholder boxes into real pictures. Nothing else is waiting on it.

### 1a. Create the R2 bucket and give it a custom domain

✅ **DONE 2026-08-13.** Bucket `agawen-media`, served at `media.agawen.com`, which resolves
to a Cloudflare IP — confirmed live and proxied.

**R2 → Create bucket → Settings → Custom Domains → Connect Domain.**

⚠︎ **Do not use the `r2.dev` URL Cloudflare offers you.** It is documented as
rate-limited and non-production, it sits outside your zone, and image transformations
cannot read from it. It looks like it works right up until it matters.

### 1b. Turn transformations ON for the zone

✅ **DONE 2026-08-13.** `*.agawen.com` is listed as a source in the `agawen.com` zone.

**Images → Transformations →** select **`agawen.com`** → enable.

⚠︎ **This must come first.** The Sources list in 1c does not exist until transformations
are enabled on the zone — it is a documented prerequisite. Doing these the other way round
just means hunting for a section that isn't there yet.

Free plan is enough: 5,000 unique transformations a month, then $0.50/1,000. A "unique
transformation" is one image at one size, counted **once per month** and cached after — not
once per visitor. Roughly: number of images × number of widths. At ~50 images × 3 widths
you're at ~150, nowhere near the cap, and a traffic spike doesn't move it.

### 1c. Allow `media.agawen.com` as a source

Still under **Images → Transformations**, with **`agawen.com`** selected, find the
**Sources** section:

1. **Add origin**
2. **Domain:** `*.agawen.com` — the `*` wildcard goes at the *start of the root domain*, and
   covers the root plus every subdomain, so this handles `media.` today and anything later
3. **Path:** leave empty (accepts any path)
4. **Add**, then **Save** — it applies immediately

⚠︎ **Why this is needed at all:** transformations accept source images only from the zone
they are served on. You serve from `agawen.com`, the images live on `media.agawen.com`, and
**a root domain does not cover its subdomains** — adding `agawen.com` alone would still
reject `media.agawen.com`. Miss this and every transform is rejected with no obvious cause.

⚠︎ There is also an **any origin** setting. Don't use it: it accepts source images from
anywhere on the internet, so anyone could burn your transformation quota on their own
images. Switching to it also **clears your sources list**, so switching back means retyping.

### 1d. Then the images themselves — IN PROGRESS

Paste the `https://media.agawen.com/...` URLs into the CMS fields. `npm run data:report`
shows progress: the visuals bars go from empty to full.

⚠︎ **One paste mistake looks completely fine and isn't.** The R2 UI offers an
`https://pub-xxxx.r2.dev/...` URL. It serves images, so it will seem to work — but it is
outside the zone and **can never be transformed**, so those images ship unoptimised at full
size forever. Always use the `media.agawen.com` form.

`data:report` now checks every pasted URL and flags r2.dev and any off-origin host by field
name, so a mistake surfaces on the next run instead of at launch. `<Media>` also refuses to
send a bad URL through the transform (it still renders — a broken page helps nobody) and
warns in `astro dev`.

---

## Stage 2 — deploying the site (~15 min)

**Now unblocked.** This step wants a repo that builds the actual site, which it didn't until
P4 landed. It does now: 54 pages.

### 2a. Push the branch

```bash
cd ~/Desktop/Tinkering/portfolio
git push -u origin astro-port
```

Review it, then merge to `main` when you're happy. Cloudflare builds from `main`.

### 2b. Create the Worker and connect the repo

**Workers & Pages → Create → Import a repository →** pick `manyprojects-co/portfolio`.

⚠︎ **The Worker's name must be exactly `agawen`** — it has to match `name` in
`wrangler.jsonc` or Workers Builds won't connect to it.

Build settings:

| field | value |
|---|---|
| Build command | `npm run build` |
| Deploy command | `npx wrangler deploy` *(the default)* |
| Non-production branch command | `npx wrangler versions upload` *(the default — preview URLs, no promotion)* |
| Root directory | leave empty |

`wrangler.jsonc` is already in the repo, so it will find `dist/` on its own. There is no
Worker script — it is assets-only, which is the simplest possible deployment.

### 2c. Point the domain at it

**Worker → Settings → Domains & Routes → Add → Custom domain → `agawen.com`**, and add
`www.agawen.com` too if you want it to resolve.

### 2d. Turn on preview builds for other branches

In the build settings, enable non-production branch builds. Every branch and PR then gets
its own URL — which is your design-review environment, and it's free.

---

## Stage 3 — two decisions, both small

### 3a. How images get replaced

The problem: a transformed image is cached at the edge against its URL. Replace a photo but
keep the filename and visitors may keep seeing the old one until the cache expires.

Two ways out. **Unique filenames** — never reuse a name; a replacement is a new URL, so it
can't be stale. Or **purge the cache on deploy** — one more moving part, and easy to forget.

**Recommendation: unique filenames.** With hand-pasted URLs it needs no infrastructure and
no discipline beyond "don't reuse a name". Worth telling Xin once, now, rather than
debugging a stale image later.

### 3b. Straight to main, or a PR gate

Pages CMS commits to `main`, which builds and deploys — so **an edit in the CMS is live in
about a minute**. Simple, and occasionally alarming.

The alternative is a branch and a pull request, so changes get a preview URL before going
live. Preview builds make this nearly free, but it puts a git step between Xin and
publishing, which is friction on the person doing the writing.

**My read: straight to `main`.** It's a portfolio, not a newspaper, and a bad edit is a
one-click revert. Revisit if an unreleased show ever needs embargoing — and note that
password-gating one is exactly the kind of thing Workers can do later without replatforming.

---

## Stage 4 — later, and independent

Point `manyprojects.co` at `agawen.com` whenever you like. It does **not** require moving
that domain to Cloudflare — a registrar-level forward is enough; a Cloudflare Redirect Rule
is tidier if it ever does move. Your email there is untouched either way.

---

## ⚠︎ The one thing to actually verify, not assume

`research-notes.md §5` flagged it and it is still open: **confirm `/cdn-cgi/image` works
under Workers Static Assets.** Cloudflare's docs describe `/cdn-cgi/` as edge-handled and
reserved, and every reason says it should be fine — but "should be fine" is what the note
warned against, and Cloudflare's own docs don't state the Workers interaction anywhere.

⭐ **You can run this NOW, before the site is deployed.** `agawen.com` has no DNS record
yet (nothing is deployed on it), but `media.agawen.com` is in the same zone and is live — and
transformations work on any hostname in the zone. So the moment the first image is uploaded:

```bash
# replace <file> with any real object in the bucket
curl -sI "https://media.agawen.com/cdn-cgi/image/width=400,format=auto/https://media.agawen.com/<file>.jpg" \
  | grep -i "^HTTP\|content-type\|content-length\|cf-resized"
```

Compare `content-length` against the untransformed original — a 400px version should be
dramatically smaller. Re-run against `https://agawen.com/...` once the site is deployed, to
confirm the same works under Workers Static Assets.

**Reading the result:**

| you get | meaning |
|---|---|
| a much smaller image, `cf-resized` header present | ✅ the whole delivery path is proven |
| the original, untouched, same size | transformations aren't enabled on the zone (1b) |
| `404` / `9401` / `9422` error | the source origin isn't allowed (1c), or the file path is wrong |

**Do this before pasting fifty URLs into the CMS**, not after — it distinguishes all three
failure modes in a single request.

---

## Order of dependency, if you only remember one thing

```
domain ✅ → R2 bucket + media.agawen.com → allowlist *.agawen.com → verify /cdn-cgi/image
                                                                          ↓
push branch → merge → Worker + Builds → custom domain → live
```

The two halves are independent. The site can go live with grey boxes, and the images can be
proven before the site is deployed. Neither is waiting on the other.
