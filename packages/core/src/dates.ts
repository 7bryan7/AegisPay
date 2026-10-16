import { z } from "zod";

export const isoCalendarDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const time = Date.parse(`${value}T00:00:00.000Z`);
  return value.slice(0, 4) !== "0000" && Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}, "must be a real ISO calendar date");
