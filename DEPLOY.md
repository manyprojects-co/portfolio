# P6 — going live

Everything here is dashboard clicks plus two numbers. Verified against Cloudflare docs
2026-08-13. Written to be followed in order — later steps depend on earlier ones existing.

**Already done:** `agawen.com` is registered at Cloudflare, so the zone is live on Cloudflare
nameservers. That was the hard prerequisite, open since Aug 5, and it gated everything below.

---

## Stage 1 — the image plumbing (~10 min)

This is what turns the grey placeholder boxes into real pictures. Nothing else is waiting on it.

### 1a. Create the R2 bucket and give it a custom domain

**R2 → Create bucket** (`mp-media` unless you prefer another name) **→ Settings → Custom
Domains → Connect Domain → `media.agawen.com`.**

⚠︎ **Do not use the `r2.dev` URL Cloudflare offers you.** It is documented as
rate-limited and non-production, it sits outside your zone, and image transformations
cannot read from it. It looks like it works right up until it matters.

### 1b. Allow that subdomain as a transformation source

**Images → Transformations → Sources → Add origin → `*.agawen.com`.**

⚠︎ The easiest step to skip and the hardest to diagnose. Transformations only accept source
images from the zone they are served on, and **a root domain does not cover its subdomains** —
`agawen.com` on its own will not accept `media.agawen.com`. Without this, every transform is
rejected and images silently fail. The wildcard covers you for any future subdomain too.

### 1c. Confirm transformations are on for the zone

**Images → Transformations** — check `agawen.com` is enabled.

Free plan is enough: 5,000 unique transformations a month, then $0.50/1,000. A
"unique transformation" is one image at one size, counted **once per month** and cached
after — not once per visitor. Roughly: number of images × number of sizes. At ~50 images
× 3 widths you are at ~150, nowhere near the cap, and a traffic spike does not move it.

### 1d. Then the images themselves

Paste the `media.agawen.com/...` URLs into the CMS fields. `npm run data:report` shows the
progress — the visuals bars go from empty to full.

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

Cheapest possible test, once one image is up:

```
https://agawen.com/cdn-cgi/image/width=400,format=auto/https://media.agawen.com/<file>.jpg
```

If that returns a 400px image, the whole delivery path is proven. If it returns the original
untouched, transformations aren't enabled (1c). If it 404s or errors, the source origin
isn't allowed (1b). **Do this before pasting fifty URLs into the CMS**, not after.

---

## Order of dependency, if you only remember one thing

```
domain ✅ → R2 bucket + media.agawen.com → allowlist *.agawen.com → verify /cdn-cgi/image
                                                                          ↓
push branch → merge → Worker + Builds → custom domain → live
```

The two halves are independent. The site can go live with grey boxes, and the images can be
proven before the site is deployed. Neither is waiting on the other.
