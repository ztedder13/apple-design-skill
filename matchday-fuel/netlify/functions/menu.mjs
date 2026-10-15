// Netlify Functions 2.0 wrapper for GET /api/menu. The logic lives in server/menu.mjs.

import { errorResponse } from "../../server/http.mjs";
import { handleMenu } from "../../server/menu.mjs";

export default async (req) => {
  try {
    return await handleMenu(req, process.env);
  } catch (error) {
    return errorResponse(error);
  }
};

export const config = { path: "/api/menu" };
