// "Who are you?" catalog. The Places query strings are what we send to Google
// Places Text/Nearby Search to find each company's existing footprint.

export type Vertical = "BFSI_ATM" | "BFSI_BRANCH" | "FMCG_RETAIL" | "FMCG_WAREHOUSE";

export interface Company {
  id: string;
  name: string;
  vertical: Vertical[];
  // Substrings Places API uses to identify this brand's locations
  placesKeywords: string[];
}

export const COMPANIES: Company[] = [
  // BFSI
  { id: "hdfc",    name: "HDFC Bank",   vertical: ["BFSI_ATM", "BFSI_BRANCH"], placesKeywords: ["HDFC Bank", "HDFC ATM"] },
  { id: "icici",   name: "ICICI Bank",  vertical: ["BFSI_ATM", "BFSI_BRANCH"], placesKeywords: ["ICICI Bank", "ICICI ATM"] },
  { id: "sbi",     name: "State Bank of India", vertical: ["BFSI_ATM", "BFSI_BRANCH"], placesKeywords: ["State Bank of India", "SBI ATM"] },
  { id: "axis",    name: "Axis Bank",   vertical: ["BFSI_ATM", "BFSI_BRANCH"], placesKeywords: ["Axis Bank", "Axis ATM"] },
  { id: "kotak",   name: "Kotak Mahindra Bank", vertical: ["BFSI_ATM", "BFSI_BRANCH"], placesKeywords: ["Kotak Mahindra Bank", "Kotak ATM"] },
  { id: "pnb",     name: "Punjab National Bank", vertical: ["BFSI_ATM", "BFSI_BRANCH"], placesKeywords: ["Punjab National Bank", "PNB ATM"] },
  { id: "bob",     name: "Bank of Baroda", vertical: ["BFSI_ATM", "BFSI_BRANCH"], placesKeywords: ["Bank of Baroda", "BoB ATM"] },
  { id: "yes",     name: "Yes Bank",    vertical: ["BFSI_ATM", "BFSI_BRANCH"], placesKeywords: ["Yes Bank"] },
  { id: "indusind",name: "IndusInd Bank", vertical: ["BFSI_ATM", "BFSI_BRANCH"], placesKeywords: ["IndusInd Bank"] },

  // FMCG / Retail
  { id: "dmart",   name: "DMart",       vertical: ["FMCG_RETAIL", "FMCG_WAREHOUSE"], placesKeywords: ["DMart", "Avenue Supermarts"] },
  { id: "reliance_retail", name: "Reliance Retail", vertical: ["FMCG_RETAIL", "FMCG_WAREHOUSE"], placesKeywords: ["Reliance Smart", "Reliance Fresh", "Reliance Trends"] },
  { id: "more",    name: "More Retail", vertical: ["FMCG_RETAIL"], placesKeywords: ["More Supermarket"] },
  { id: "bigbasket", name: "BigBasket", vertical: ["FMCG_RETAIL", "FMCG_WAREHOUSE"], placesKeywords: ["BigBasket"] },
  { id: "zepto",   name: "Zepto",       vertical: ["FMCG_WAREHOUSE"], placesKeywords: ["Zepto"] },
  { id: "blinkit", name: "Blinkit",     vertical: ["FMCG_WAREHOUSE"], placesKeywords: ["Blinkit", "Grofers"] },
  { id: "swiggy_instamart", name: "Swiggy Instamart", vertical: ["FMCG_WAREHOUSE"], placesKeywords: ["Instamart"] },
  { id: "itc",     name: "ITC",         vertical: ["FMCG_RETAIL", "FMCG_WAREHOUSE"], placesKeywords: ["ITC store"] },
  { id: "hul",     name: "Hindustan Unilever", vertical: ["FMCG_RETAIL", "FMCG_WAREHOUSE"], placesKeywords: ["Hindustan Unilever"] },
  { id: "nestle",  name: "Nestlé India", vertical: ["FMCG_RETAIL", "FMCG_WAREHOUSE"], placesKeywords: ["Nestle"] },
];

export function getCompany(id: string): Company | undefined {
  return COMPANIES.find(c => c.id === id);
}

export function companiesForVertical(v: Vertical): Company[] {
  return COMPANIES.filter(c => c.vertical.includes(v));
}

// Generic POI category to search for, depending on vertical.
// This is what we send to Google Places to count "all relevant POIs" in an area,
// regardless of brand.
export const VERTICAL_PLACES_TYPE: Record<Vertical, string> = {
  BFSI_ATM:       "atm",
  BFSI_BRANCH:    "bank",
  FMCG_RETAIL:    "supermarket",
  FMCG_WAREHOUSE: "storage",
};

// Scoring weights per vertical.
// demand: how much population/affluence matters
// saturation: how much competitor density hurts
// access: roads/transit importance
// growth: AI-discovered future signals
export const VERTICAL_WEIGHTS: Record<Vertical, { demand: number; saturation: number; access: number; growth: number }> = {
  BFSI_ATM:       { demand: 0.40, saturation: 0.30, access: 0.20, growth: 0.10 },
  BFSI_BRANCH:    { demand: 0.35, saturation: 0.25, access: 0.20, growth: 0.20 },
  FMCG_RETAIL:    { demand: 0.45, saturation: 0.25, access: 0.15, growth: 0.15 },
  FMCG_WAREHOUSE: { demand: 0.25, saturation: 0.10, access: 0.40, growth: 0.25 },
};

// Default economics per vertical, used to turn a grounded MONTHLY revenue estimate
// into a payback-period figure. These are EDITABLE DEFAULTS (the UI lets the user
// override them) and deliberately conservative round numbers — a starting model,
// not a forecast. Sources: typical Indian unit economics (operating margin %,
// one-time fit-out/setup capex, monthly rent already comes from 99acres scrape).
//   marginPct  → operating margin on revenue that services payback
//   setupCapex → one-time fit-out / equipment / deposit (₹)
export interface VerticalEconomics {
  marginPct: number;       // 0..1 operating margin
  setupCapex: number;      // one-time ₹ to open the site
  label: string;           // what the site is, for UI copy
}

export const VERTICAL_ECONOMICS: Record<Vertical, VerticalEconomics> = {
  // ATM: thin margin on interchange, low fit-out (machine + cabin + deposit).
  BFSI_ATM:       { marginPct: 0.30, setupCapex: 1_500_000, label: "ATM" },
  // Branch: higher fixed cost, staff, larger fit-out.
  BFSI_BRANCH:    { marginPct: 0.25, setupCapex: 6_000_000, label: "branch" },
  // Grocery/retail: low margin, moderate fit-out + inventory.
  FMCG_RETAIL:    { marginPct: 0.12, setupCapex: 4_000_000, label: "store" },
  // Dark store / warehouse: low margin, racking + cold chain + deposit.
  FMCG_WAREHOUSE: { marginPct: 0.10, setupCapex: 5_000_000, label: "dark store" },
};
