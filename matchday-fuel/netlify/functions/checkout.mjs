// Netlify Functions 2.0 wrapper for POST /api/checkout. The logic lives in server/checkout.mjs.

import { handleCheckout } from "../../server/checkout.mjs";
import { errorResponse } from "../../server/http.mjs";

export default async (req) => {
  try {
    return await handleCheckout(req, process.env);
  } catch (error) {
    return errorResponse(error);
  }
};

export const config = { path: "/api/checkout" };
