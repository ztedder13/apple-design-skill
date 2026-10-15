// Netlify Functions 2.0 wrapper for GET /api/schedule. The logic lives in server/schedule.mjs.

import { errorResponse } from "../../server/http.mjs";
import { handleSchedule } from "../../server/schedule.mjs";

export default async (req) => {
  try {
    return await handleSchedule(req, process.env);
  } catch (error) {
    return errorResponse(error);
  }
};

export const config = { path: "/api/schedule" };
