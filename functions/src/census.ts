// India Post free PIN code API → city/district → fed into the report.
// data.gov.in census endpoints exist but require API key + are flaky; we use
// India Post as a free, no-auth PIN→geo lookup, and let Wikipedia/Gemini fill
// in the population.

import axios from "axios";

export interface PinInfo {
  pin: string;
  postOffices: string[];
  district: string;
  state: string;
}

const POSTAL_API = "https://api.postalpincode.in/pincode/";

export async function pinInfo(pin: string): Promise<PinInfo | null> {
  try {
    const resp = await axios.get(`${POSTAL_API}${pin}`, { timeout: 5_000 });
    const arr = resp.data?.[0];
    if (!arr || arr.Status !== "Success") return null;
    const offices = arr.PostOffice ?? [];
    if (!offices.length) return null;
    return {
      pin,
      postOffices: offices.map((o: any) => o.Name).slice(0, 5),
      district: offices[0].District,
      state: offices[0].State,
    };
  } catch {
    return null;
  }
}
