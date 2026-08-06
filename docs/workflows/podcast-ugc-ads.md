# INTERNAL: 60-Second AI Podcast-Style Interview Ads (one generation)

**INTERNAL HERMES WORKFLOW ONLY — never publish into the recipe catalog or
sync to StageSnap tenant recipes.** This is our edge, not a product feature.
Source: "How I Make 60 Second AI Podcast Ads In One Generation"
(flat-quiver-544.notion.site, captured 2026-08-04).

## The method, summarized

Two AI hosts, same room, one continuous 60s podcast conversation — generated
in ONE pass (no per-line stitching, no editor). Format converts because
nobody's guard is up for an ad that isn't pointed at them: the "ad" is two
people talking, the product surfaces around 0:42 after ~35s of pure
education, by which point the listener has already agreed with three things.

1. **Tool:** infiniteugc.com — its Podcast tab takes a full two-speaker
   script and returns one video (everything else caps at 10–15s/generation,
   forcing per-line stitching and room-matching hell). Model: **Google
   Omni** — current best for podcast UGC. Credits are quoted AFTER it plans
   the video (no blind spend).
2. **Hosts (image gen, style: Podcast UGC):** never prompt a face from
   scratch ("girl at a mic" = same generic person every time). Instead:
   screenshot a real TikTok podcast clip with framing you like → drop in as
   REFERENCE → rebuild: same framing/mic/posture, different person. Host B:
   describe the same room word-for-word (matching wall, light, mic). Reroll
   until both look shot on the same day — images cost pennies, a bad frame
   costs the whole video.
3. **Casting:** never "two people chatting." Host A EXPLAINS (just found
   something out, telling her friend). Host B REACTS in short lines only
   ("wait, what?" / "half?! that's so unfair" / "okay I'm buying that
   tonight"). **Host B's questions are the buyer's objections** — she does
   the selling.
4. **Script (Claude, paste both host images in):** the working prompt —
   read/analyze [your URL] for the strongest marketing points, hook for
   engagement, script the body for CVR; gen-z conversational style; "no
   abrupt hard selling" (this line is what stops it writing an advert);
   educational friend-explaining-a-discovery tone; back-and-forth in plain
   text labeled Host A / Host B.
5. **Generate:** paste the WHOLE script into infiniteugc's "use AI to auto
   sort" — it assigns every line to the right speaker. Visual instructions
   optional (only for specific actions like grabbing a product); the
   software handles micro-expressions (blinks, chair shifts, arm movement)
   unprompted.

## Our workflow (Hermes-automated, per product)

**Products & angles** (rotate; Host B's objections come from Reddit
pain-mining per the GTM plan):
- **StageSnap** → "she found a tool that stages listing photos for like a
  dollar" / the Flying-in Restyle clip as a show-and-tell beat.
- **LoanGraphs** → LO-audience version: "she replaced Homebot + myhomeIQ +
  MBS Highway ($500/mo) with one tool that also ranks her on Google."
- **mydreamTC** → TC-challenge angle for the webinar funnel.

**Pipeline** (Hermes cron/recipe-style, but INTERNAL):
1. **Host library (one-time per brand, human taste step):** Alex approves
   2-3 host pairs per audience (realtor-adjacent pair, LO-adjacent pair)
   built via the reference-screenshot technique. Store approved host images
   + room descriptions in the tenant DB as assets (kind: `ugc_host_pair`).
2. **Script generation (automated):** Hermes job → Claude with the article's
   prompt template + the product's live landing page URL + current
   objection list from the metrics/pain DB → 60s A/B-labeled script.
   HUMAN REVIEW: Alex approves scripts before generation (cheap step, keeps
   voice on-brand).
3. **Generate — OUR OWN STACK (Alex 2026-08-04: no infiniteugc):**
   the insight that makes this buildable in-house is that PODCAST GRAMMAR IS
   CUTS — real podcasts cut between per-speaker camera angles constantly, so
   we don't need one 60s continuous generation (infiniteugc's whole pitch);
   we need per-line talking clips cut together, which is our Remotion
   chassis's day job:
   a. Hosts: nano-banana (Gemini image edit — same model StageSnap uses) via
      the TikTok reference-screenshot technique; both hosts generated into
      the SAME described room = consistency solved at the image layer.
   b. Voices: ElevenLabs (already on the GTM key shopping list) — one voice
      per host, per-line audio.
   c. Talking clips: per line, host image + line audio → lipsync/avatar
      route via kie.ai (or HeyGen, already in StageSnap's provider catalog);
      short clips are the CHEAP case on every provider.
   d. Assembly: Remotion — speaker cuts on line boundaries, subtle push-ins,
      captions, music bed, brand end-card; renders on the Coolify worker
      like everything else. Optional b-roll inserts via Grok Imagine/kie.
   All on our keys, per-clip costs in pennies, and every piece (hosts,
   voices, scripts, winning patterns) accumulates as reusable assets in the
   tenant DB instead of living inside a third-party tool.
4. **Deploy into the Cody testing loop:** goes into the daily ad-testing
   cadence (5 ads/day mix), optimized on Lead events; performance lands in
   the tenant metrics DB; winners get spend, winning SCRIPT PATTERNS get
   fed back into step 2's prompt as exemplars.
5. **Cadence:** 2-3 podcast ads/week per product once hosts are approved.

**Why internal-only:** the host-reference technique + prompt + product-at-
0:42 structure is exactly the kind of replicable edge that dies when every
LO/realtor tenant runs the same format at the same audience. Recipes get the
generic stuff; this stays ours.
