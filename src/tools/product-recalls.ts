/**
 * MCP tool: get_product_recalls
 *
 * Returns product safety recalls from five federal agencies under one
 * unified shape (source discriminator). Pairs naturally with
 * get_material_events (8-K Item 7.01 / 8.01 often disclose recalls),
 * get_insider_transactions (insider activity around recall dates), and
 * get_enforcement_actions (FDA / DOJ / SEC follow-on when recalls escalate).
 *
 * Sources:
 *   fda_drug   — openFDA /drug/enforcement.json
 *   fda_device — openFDA /device/enforcement.json
 *   fda_food   — openFDA /food/enforcement.json
 *   cpsc       — saferproducts.gov/RestWebServices/Recall
 *   nhtsa      — NHTSA recalls (vehicles, tires, equipment) — deferred to v1A.1
 *                (only api.nhtsa.gov endpoint is recallsByVehicle which needs
 *                make+model+year per call, not bulk-friendly; CSV bulk
 *                dataset URL needs investigation)
 *
 * v1A scope: metadata + reason + classification. Full hazard details and
 * remediation steps live at source_url for agent follow-through. Pure-
 * publisher posture — severity is the agency's own classification, never
 * a derived KeyVex score.
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { queryProductRecalls } from "../firestore.js";
import type {
  ProductRecall,
  ProductRecallsQuery,
  ResultEnvelope,
} from "../types.js";

export const definition: Tool = {
  name: "get_product_recalls",
  annotations: {
    title: "Product Recalls (FDA / CPSC)",
    readOnlyHint: true,
    openWorldHint: true,
  },
  description: [
    "Returns safety recalls from federal agencies — drug recalls (FDA),",
    "medical device recalls (FDA), food/dietary supplement recalls (FDA),",
    "and (coming in v1A.1) vehicle recalls (NHTSA) and consumer-product",
    "recalls (CPSC). Use this when the user asks about: recent recalls",
    "for a specific company or product, FDA Class I (most severe) recalls,",
    "active vehicle recalls by make/model, food contamination recalls,",
    "drug shortages and recalls, or to add a 'product-safety event' flag",
    "to insider activity / 8-K filings / enforcement actions.",
    "",
    "Sources (filter via the `source` enum):",
    "  fda_drug   — openFDA /drug/enforcement.json. Drug recalls including",
    "               prescription, OTC, biologics. Class I/II/III severity.",
    "  fda_device — openFDA /device/enforcement.json. Medical device recalls",
    "               (implants, diagnostics, equipment, software). Same",
    "               classification scheme.",
    "  fda_food   — openFDA /food/enforcement.json. Food + dietary supplements.",
    "               Pathogen contamination, allergen mislabeling, etc.",
    "  cpsc       — saferproducts.gov RestWebServices/Recall. Consumer-product",
    "               recalls (clothing, electronics, toys, batteries, etc.). No",
    "               severity classification; classification field is null.",
    "  nhtsa      — Vehicle, tire, equipment, child-seat recalls. Deferred to",
    "               v1A.1 (api.nhtsa.gov bulk endpoint pending investigation).",
    "",
    "Cross-source pairing pattern:",
    "  Recall → 8-K Item 7.01/8.01:  pair with get_material_events",
    "  Recall → insider sells:       pair with get_insider_transactions",
    "  Recall → SEC/DOJ follow-on:   pair with get_enforcement_actions",
    "  Recall → company filings:     pair with get_proxy_filings (DEF 14A risk factors)",
    "",
    "Each record is one recall. Identifier format: `{source}-{recall_number}`",
    "(e.g., 'fda_drug-D-1234-2026'). FDA classifications:",
    "  Class I   — serious adverse health consequence or death",
    "  Class II  — temporary or reversible health consequence",
    "  Class III — unlikely to cause adverse health consequence",
  ].join(" "),
  inputSchema: {
    type: "object",
    properties: {
      source: {
        type: "string",
        enum: ["fda_drug", "fda_device", "fda_food", "nhtsa", "cpsc"],
        description:
          "Filter to a single agency / category. Omit to see all sources combined.",
      },
      recall_number: {
        type: "string",
        description:
          "Recall identifier as filed (e.g., FDA 'D-1234-2026'). Combine with source for direct doc lookup, fastest path.",
      },
      recalling_firm: {
        type: "string",
        description:
          "Case-insensitive substring against the recalling firm name (e.g., 'Pfizer', 'Toyota', 'Whole Foods').",
      },
      product_description: {
        type: "string",
        description:
          "Case-insensitive substring against the product description (e.g., 'lithium', 'romaine', 'airbag').",
      },
      classification: {
        type: "string",
        enum: ["Class I", "Class II", "Class III"],
        description:
          "FDA severity classification. Class I is most severe (death / serious harm). Ignored for NHTSA / CPSC records.",
      },
      status: {
        type: "string",
        description:
          "Exact match. Common values: 'Ongoing', 'Completed', 'Terminated', 'Recall Initiated'.",
      },
      vehicle_make: {
        type: "string",
        description:
          "NHTSA-only filter. Vehicle make, uppercase (e.g., 'TOYOTA', 'FORD'). Ignored for other sources.",
      },
      vehicle_model: {
        type: "string",
        description:
          "NHTSA-only filter. Case-insensitive substring against vehicle model. Ignored for other sources.",
      },
      since: {
        type: "string",
        description:
          "ISO date (YYYY-MM-DD). Only recalls whose recall_initiation_date is on or after this date.",
      },
      until: {
        type: "string",
        description:
          "ISO date (YYYY-MM-DD). Only recalls whose recall_initiation_date is on or before this date.",
      },
      sort_by: {
        type: "string",
        enum: ["recall_initiation_date", "posted_date"],
        description: "Default: recall_initiation_date.",
      },
      sort_order: {
        type: "string",
        enum: ["desc", "asc"],
        description: "Default: desc (most recent first).",
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 500,
        description: "Maximum records to return. Default 50, max 500.",
      },
    },
    additionalProperties: false,
  },
};

export async function handler(
  args: unknown,
): Promise<ResultEnvelope<ProductRecall>> {
  const query = validateAndNormalize(args);
  const { results, has_more } = await queryProductRecalls(query);
  return {
    results,
    count: results.length,
    has_more,
    query: query as Record<string, unknown>,
  };
}

const SOURCE_ALLOWED = new Set([
  "fda_drug",
  "fda_device",
  "fda_food",
  "nhtsa",
  "cpsc",
]);

function validateAndNormalize(raw: unknown): ProductRecallsQuery {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Arguments must be an object");
  }
  const args = raw as Record<string, unknown>;
  const out: ProductRecallsQuery = {};

  if (args.source !== undefined) {
    if (typeof args.source !== "string" || !SOURCE_ALLOWED.has(args.source)) {
      throw new Error(
        `INVALID source: '${String(args.source)}' — expected one of ${[...SOURCE_ALLOWED].join(", ")}`,
      );
    }
    out.source = args.source as ProductRecallsQuery["source"];
  }
  if (args.recall_number !== undefined) {
    if (typeof args.recall_number !== "string") {
      throw new Error("recall_number must be a string");
    }
    out.recall_number = args.recall_number;
  }
  if (args.recalling_firm !== undefined) {
    if (typeof args.recalling_firm !== "string") {
      throw new Error("recalling_firm must be a string");
    }
    out.recalling_firm = args.recalling_firm;
  }
  if (args.product_description !== undefined) {
    if (typeof args.product_description !== "string") {
      throw new Error("product_description must be a string");
    }
    out.product_description = args.product_description;
  }
  if (args.classification !== undefined) {
    if (typeof args.classification !== "string") {
      throw new Error("classification must be a string");
    }
    out.classification = args.classification;
  }
  if (args.status !== undefined) {
    if (typeof args.status !== "string") {
      throw new Error("status must be a string");
    }
    out.status = args.status;
  }
  if (args.vehicle_make !== undefined) {
    if (typeof args.vehicle_make !== "string") {
      throw new Error("vehicle_make must be a string");
    }
    out.vehicle_make = args.vehicle_make.toUpperCase();
  }
  if (args.vehicle_model !== undefined) {
    if (typeof args.vehicle_model !== "string") {
      throw new Error("vehicle_model must be a string");
    }
    out.vehicle_model = args.vehicle_model;
  }
  if (args.since !== undefined) {
    out.since = parseIsoDate(args.since, "since");
  }
  if (args.until !== undefined) {
    out.until = parseIsoDate(args.until, "until");
  }
  if (args.sort_by !== undefined) {
    if (
      args.sort_by !== "recall_initiation_date" &&
      args.sort_by !== "posted_date"
    ) {
      throw new Error(
        `INVALID sort_by: '${String(args.sort_by)}' — expected recall_initiation_date | posted_date`,
      );
    }
    out.sort_by = args.sort_by;
  }
  if (args.sort_order !== undefined) {
    if (args.sort_order !== "desc" && args.sort_order !== "asc") {
      throw new Error(
        `INVALID sort_order: '${String(args.sort_order)}' — expected 'desc' or 'asc'`,
      );
    }
    out.sort_order = args.sort_order;
  }
  if (args.limit !== undefined) {
    if (
      typeof args.limit !== "number" ||
      !Number.isInteger(args.limit) ||
      args.limit < 1 ||
      args.limit > 500
    ) {
      throw new Error(
        `INVALID limit: '${String(args.limit)}' — expected integer 1..500`,
      );
    }
    out.limit = args.limit;
  }

  return out;
}

function parseIsoDate(value: unknown, fieldName: string): string {
  if (typeof value !== "string") {
    throw new Error(`INVALID_DATE: ${fieldName} must be a string`);
  }
  if (!/^\d{4}-\d{2}-\d{2}/.test(value)) {
    throw new Error(
      `INVALID_DATE: ${fieldName}='${value}' — expected YYYY-MM-DD`,
    );
  }
  return value;
}
