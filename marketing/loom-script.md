# Loom Demo Video — Script & Outline

> **REVIEW NOTES (not for posting yet)**
>
> Target length: **3-5 minutes**. Sweet spot for HN/Reddit attention. Anything longer drops viewer-completion rate sharply.
>
> Tone: builder-honest. First-person, conversational, unscripted-sounding. Not a polished marketing video — viewers should feel like they're sitting next to Greg watching him use the thing.
>
> Recording setup:
> - **Loom Pro** (free 25 videos under 5 min — fits)
> - **Camera bubble**: top-right, small. Greg's face visible builds trust.
> - **Resolution**: 1080p
> - **Audio**: external mic if available, otherwise built-in is fine. Test for echo first.
> - **Browser**: clean Chrome window, no other tabs. Bookmarks bar hidden.
> - **Claude Desktop**: open and connected to mcp.keyvex.com/api (the MCP API endpoint). Test the connection works BEFORE hitting record.
> - **Lighting**: face the window or a lamp. Avoid backlighting that silhouettes you.
>
> One-take or multi-take?
> - **Recommended: 2-3 takes max.** First take is rough. Second take refines. Third take is the keeper. Past 3, you start sounding overly rehearsed.
> - Don't edit. Loom's strength is "raw and real." If you flub a word, just continue. Stuttering is human; over-edited demos look like ads.

---

## Section breakdown (5 minutes total)

| Section | Duration | What you do |
|---|---|---|
| 1. Cold open / hook | 0:00 - 0:25 | Visible on camera. State the problem in one sentence. |
| 2. The setup | 0:25 - 0:50 | Show Claude Desktop connected to KeyVex. One-line context. |
| 3. The demo | 0:50 - 3:30 | Type the political-alpha LMT prompt. Show responses across 4 tools. |
| 4. Behind the scenes | 3:30 - 4:15 | Brief — landing page, sources list, "this is just the agent's surface" |
| 5. CTA + wrap | 4:15 - 5:00 | Free tier, link, sign-off |

---

## SECTION 1 — Cold open / hook (0:00 - 0:25)

**On camera, no screen share yet.**

> "Hey. I'm Greg. I built KeyVex because every existing financial-data MCP server I tried gave my agent a hundred tools and burned half its context window before it could even reason. So I built one that gives the agent twelve tools and thirteen sources of US public-disclosure data — and lets it triangulate across all of them in one conversation. Let me show you."

**Cut to screen share.**

*Note: keep this opening tight. The viewer's hand is on the back-button. The hook has to land in 25 seconds or they bounce.*

---

## SECTION 2 — The setup (0:25 - 0:50)

**Show Claude Desktop with the KeyVex MCP server already connected (green dot in the MCP server panel, or the tools-available indicator).**

> "Quick context: Claude Desktop, with KeyVex configured as an MCP server. Bearer-authenticated, points at `mcp.keyvex.com/api`. The agent can see twelve tools. I'm not going to walk through each one — instead I'll show you what becomes possible when an agent can compose them."

> "Let me ask it a real question."

*Note: if you want to show the configuration briefly, point at the server-list panel for ~3 seconds. Don't dwell.*

---

## SECTION 3 — The demo (0:50 - 3:30) ← THE MEAT

**Type into Claude Desktop:**

```
Has anything weird happened with Lockheed Martin lately? Cross-check
congressional trades, federal contract awards, recent material 8-K
disclosures, and lobbying spend. Look for any pattern across them.
```

**While Claude is thinking (it'll fan out to multiple tools), narrate:**

> "Notice the agent is making multiple tool calls. It's hitting `get_congressional_trades` for LMT, `get_federal_contracts` for Lockheed, `get_material_events` for the 8-Ks, and `get_lobbying_filings` for who's spending lobbying money on Lockheed's behalf. Four data sources — congressional, federal contracting, SEC filings, lobbying — all in one conversation."

**When Claude finishes its response, scroll through the response showing:**

- A few specific congressional trades (probably some from the Defense Committee members)
- A federal contract award amount + date
- An 8-K filing (probably an item 1.01 material agreement)
- A lobbying filing showing the registrants Lockheed pays

**Narrate while scrolling:**

> "Here it found that Senator [whoever] traded LMT options on [date], two weeks before a [contract award amount] award from the DoD that Lockheed disclosed in an 8-K. Lockheed's been paying [law firm] [amount] in Q3 lobbying."

> "Now — the agent didn't decide that's suspicious or interesting. KeyVex doesn't return signal scores. It returns the raw filings. The agent — and the human reading the agent's output — decides what to do with that. That's the design."

*Backup demo if LMT doesn't yield a clean story: have a fallback ticker prepped. NVDA is usually rich; AAPL has Vanguard 13G activity; PFE has heavy lobbying spend.*

*If the agent chains slowly or hits a tool latency, just narrate over it. "This is hitting the live MCP endpoint, real Firestore queries, real SEC filings." Don't apologize for response time.*

---

## SECTION 4 — Behind the scenes (3:30 - 4:15)

**Open a new tab. Show `keyvex.com` landing page.**

> "Real quick — if you want to see everything KeyVex covers, here's the landing page. Thirteen distinct sources. Form 4 insider trades, Form 144 planned sales, Form 3 baselines, 13F holdings, 13D and 13G activist disclosures, 8-K material events, Form 278 net-worth filings, Senate and House congressional trades, federal contracts, lobbying, current and historical legislators going back to seventeen-eighty-nine."

**Scroll down the landing page briefly to show the sources grid.**

> "About a hundred and sixty-five thousand records across the collections. Kept fresh by autonomous Cloud Functions. Bearer-authenticated. There's a free tier — five thousand calls a month, no credit card required."

---

## SECTION 5 — CTA + wrap (4:15 - 5:00)

**Back on camera (or stay on landing page if simpler).**

> "If you build agents that need US public-disclosure data — please poke at it. Free tier is real. Signup takes thirty seconds. The API endpoint is `mcp.keyvex.com/api`. The product page is `mcp.keyvex.com`. The company is `keyvex.com`."

> "If you find a question your agent can't answer, that's the kind of feedback I most want."

> "Thanks for watching."

*End the recording cleanly. Don't trail off. Loom's auto-stop is fine.*

---

## Things to test BEFORE recording

- [ ] **Claude Desktop is talking to mcp.keyvex.com/api.** Verify by asking it any KeyVex tool query in a test conversation. If MCP server shows red or "disconnected," fix before recording.
- [ ] **The LMT prompt actually returns substantive cross-source results.** Test it once in a throwaway Claude conversation. If the agent comes back with "no matches found" on one of the sources, swap the ticker (NVDA, BA, RTX as fallbacks).
- [ ] **Lockheed Martin really has data across all four sources.** Quick spot-check via curl:
  ```bash
  curl -X POST https://mcp.keyvex.com/api -H "Authorization: Bearer <key>" \
    -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
    -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_congressional_trades","arguments":{"ticker":"LMT","limit":3}}}'
  ```
  Run for each tool you'll demo. Confirm at least 1-2 records on each.

- [ ] **Browser is clean** — no other tabs visible, bookmarks bar hidden, no notification badges.
- [ ] **Loom permissions** — mic + screen share approved.
- [ ] **Test record 30-second clip first.** Watch it back. Check audio levels, that the camera bubble isn't covering anything important, that the screen is readable on a small Loom thumbnail.

---

## Where the video gets posted

Once recorded, the Loom URL gets used:

- Embedded in the **Show HN body** (HN typically allows one media link)
- Linked in the **Reddit r/MCP and r/aiagents posts**
- Pinned at the top of the **@keyvex_ X profile** (or as the first tweet of the launch thread, replacing tweet 11's text-only ending)
- Featured on the **landing page** at `keyvex.com` (just below the hero, before the sources grid) — quick HTML edit when ready

---

## Optional: shorter cut for X (60-90 sec)

X autoplay videos cut off engagement past ~60 sec. If you want a punchy version specifically for the X thread, record a second take that's:

- 0:00 - 0:10: hook ("Twelve tools, thirteen sources, one prompt.")
- 0:10 - 0:50: the LMT demo, sped up — just type the prompt, watch the agent fan out, scroll the result
- 0:50 - 1:00: "Free tier at keyvex.com"

This is optional — the longer Loom plus a still screenshot from it works fine for the X thread too.

---

## Bottom-line: how long does the recording take?

- Pre-record setup (clean browser, test MCP, run curls): **15-20 min**
- Recording (3 takes): **15-20 min**
- Light editing if any (probably none): **5 min**

**Total: 30-45 min from start to publishable Loom URL.** Don't budget more than 60. If take 4 isn't landing, the script needs revisiting, not more takes.
