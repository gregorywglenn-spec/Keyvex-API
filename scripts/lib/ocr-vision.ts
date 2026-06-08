/**
 * ocr-vision — read a scanned House PTR page image into structured trade
 * rows via a Claude vision model. This is the "vision" half of the scanned-
 * PTR pipeline; scripts/ingest-house-ocr.ts is the "save" half.
 *
 * Why vision (not Document AI): the PTR checkmark grid is read by which BOX
 * is filled, which the model sees directly — geometry OCR loses the column
 * structure and coin-flips Purchase-vs-Sale / amount-bracket boundaries.
 */
import { readFileSync } from "node:fs";

const API = "https://api.anthropic.com/v1/messages";

export interface VisionRow {
  asset_name: string;
  ticker: string;
  asset_type: string;
  owner: "Self" | "Spouse" | "Joint" | "Dependent";
  type: "buy" | "sell" | "exchange";
  tx_date: string; // MM/DD/YYYY as printed
  notif_date: string;
  amount_col: string; // A–K
  comment: string;
}
export interface VisionResult {
  nil: boolean;
  rows: VisionRow[];
  notes: string;
}

const SYSTEM = `You read scanned US House of Representatives Periodic Transaction Report (PTR) forms and output ONLY the transactions actually marked on the form. Be exact and conservative — never invent a row, never guess a value you cannot see.

FORM LAYOUT (a grid; one transaction per data row):
- Left margin owner code: "SP"=Spouse, "JT"=Joint, "DC"=Dependent child, blank=Self (the filer).
- FULL ASSET NAME column: company/fund name. A ticker may appear in parentheses like (NTAP).
- TYPE OF TRANSACTION: checkbox columns "Purchase", "Sale", "Partial Sale" (sometimes absent), "Exchange". Read which BOX holds the X/checkmark.
- DATE OF TRANSACTION and DATE NOTIFIED: MM/DD/YY or MM/DD/YYYY.
- AMOUNT OF TRANSACTION: checkbox columns labeled A–K. Read which box holds the X. The letters map to:
  A $1,001-$15,000 | B $15,001-$50,000 | C $50,001-$100,000 | D $100,001-$250,000 | E $250,001-$500,000 | F $500,001-$1,000,000 | G $1,000,001-$5,000,000 | H $5,000,001-$25,000,000 | I $25,000,001-$50,000,000 | J Over $50,000,000 | K Spouse/Dependent asset over $1,000,000.

ATTACHED SCHEDULES: Some filers leave the checkbox grid blank and write "See attached schedules" (or similar). The FOLLOWING page(s) then carry a TYPED table with the SAME columns — full asset name, Purchase/Sale/Partial Sale/Exchange marks, date of transaction, and amount column A–K. Those typed rows ARE real transactions and MUST be extracted, one row each, exactly like grid rows. The asset names there are often muni bonds, brokerage holdings, or property/LLC interests with long descriptions — capture the full asset_name. Do not return nil just because the first page's grid is empty; read the attached schedule.

CRITICAL RULES:
1. IGNORE the pre-printed "Example: Mega Corp. Common Stock" row (it always has a Sale X and a B amount X). It is NOT a real transaction.
2. If the form says "Nothing to report" (for a month/period), or has no marked data rows, return nil=true with an empty rows array.
3. To place a checkmark, compare the filled box to the EMPTY boxes beside it in the same row. The X sits INSIDE one cell; pick that cell's column.
4. type: Purchase->"buy"; Sale or Partial Sale->"sell"; Exchange->"exchange".
5. Read amount as the column LETTER (A–K), not the dollar text.
6. Only output a row if it has a real asset name AND at least a type or amount mark. If a value is genuinely unreadable, put "" for that field.
7. The "comment" field is ONLY for text actually written/printed on the form for that row — e.g. account type ("IRA", "401k"), a per-share price ("@19.72"), or a filer's note. Do NOT put your own reasoning, observations about the form, owner-code logic, or notes about date formatting in it. Empty string if the row has no such annotation.
8. The "notes" field (top level) is where any of your observations/uncertainty go — NOT in per-row comments.
9. Output STRICT JSON only, no prose, no markdown fences.

OUTPUT JSON shape:
{"nil": boolean, "rows": [{"asset_name": str, "ticker": str, "asset_type": str, "owner": "Self|Spouse|Joint|Dependent", "type": "buy|sell|exchange", "tx_date": str, "notif_date": str, "amount_col": "A".."K", "comment": str}], "notes": str}`;

function pngToB64(path: string): string {
  return readFileSync(path).toString("base64");
}

/**
 * Detect the clockwise rotation (0/90/180/270) needed to make a scanned page
 * upright. House PTR scans arrive at varying orientations and we must orient
 * before cropping/reading. Cheap call on a downscaled image.
 */
export async function detectRotation(
  pngPath: string,
  model = "claude-haiku-4-5-20251001",
): Promise<0 | 90 | 180 | 270> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY not set");
  const res = await fetch(API, {
    method: "POST",
    headers: {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 10,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: pngToB64(pngPath),
              },
            },
            {
              type: "text",
              text: "This is a scanned form that may be rotated. Reply with ONLY one number — the CLOCKWISE rotation in degrees (0, 90, 180, or 270) needed to make the printed text upright and horizontally readable. The title 'United States House of Representatives' should end up across the top. Reply with just the number.",
            },
          ],
        },
      ],
    }),
  });
  const j: any = await res.json();
  const txt: string = j.content?.[0]?.text ?? "0";
  const n = parseInt((txt.match(/\d+/)?.[0] ?? "0"), 10);
  return ([0, 90, 180, 270].includes(n) ? n : 0) as 0 | 90 | 180 | 270;
}

export async function extractTradesFromImage(
  pngPaths: string | string[],
  model = "claude-haiku-4-5-20251001",
): Promise<VisionResult> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY not set");
  const paths = Array.isArray(pngPaths) ? pngPaths : [pngPaths];

  const content: any[] = [];
  if (paths.length > 1)
    content.push({
      type: "text",
      text: `This filing has ${paths.length} page images, in order. Extract every real transaction across all of them.`,
    });
  for (const p of paths) {
    content.push({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: pngToB64(p) },
    });
  }
  content.push({
    type: "text",
    text: "Read the form and call report_transactions with every real transaction.",
  });

  // Forced tool use GUARANTEES structured output (newer models like
  // sonnet-4-6 don't support assistant prefill, and a strong system prompt
  // alone still occasionally lapses into prose). tool_choice forces the call.
  const tool = {
    name: "report_transactions",
    description:
      "Report the transactions read from the scanned House PTR form. Call exactly once.",
    input_schema: {
      type: "object",
      properties: {
        nil: {
          type: "boolean",
          description: "true if the form has no real transactions / says 'nothing to report'",
        },
        notes: { type: "string", description: "your observations/uncertainty (NOT per-row)" },
        rows: {
          type: "array",
          items: {
            type: "object",
            properties: {
              asset_name: { type: "string" },
              ticker: { type: "string" },
              asset_type: { type: "string" },
              owner: { type: "string", enum: ["Self", "Spouse", "Joint", "Dependent"] },
              type: { type: "string", enum: ["buy", "sell", "exchange"] },
              tx_date: { type: "string" },
              notif_date: { type: "string" },
              amount_col: { type: "string", description: "amount column letter A–K" },
              comment: { type: "string" },
            },
            required: ["asset_name", "type", "amount_col", "owner"],
          },
        },
      },
      required: ["nil", "rows"],
    },
  };

  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(API, {
      method: "POST",
      headers: {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: 16384,
        system: SYSTEM,
        messages: [{ role: "user", content }],
        tools: [tool],
        tool_choice: { type: "tool", name: "report_transactions" },
      }),
    });
    if (res.status === 429 || res.status >= 500) {
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      continue;
    }
    const j: any = await res.json();
    if (!res.ok)
      throw new Error(`anthropic ${res.status}: ${JSON.stringify(j).slice(0, 300)}`);
    const block = (j.content ?? []).find((b: any) => b.type === "tool_use");
    if (!block?.input) {
      if (attempt === 3)
        throw new Error(`no tool_use in reply: ${JSON.stringify(j.content).slice(0, 300)}`);
      continue;
    }
    const parsed = block.input as VisionResult;
    return {
      nil: !!parsed.nil,
      rows: Array.isArray(parsed.rows) ? parsed.rows : [],
      notes: parsed.notes ?? "",
    };
  }
  throw new Error("vision extraction failed after retries");
}
