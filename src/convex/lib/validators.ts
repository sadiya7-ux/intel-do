import { v } from "convex/values";

/** A single retrieved passage shown as a citation under an answer. */
export const sourceValidator = v.object({
  label: v.string(),
  documentId: v.id("documents"),
  fileName: v.string(),
  pageNumber: v.number(),
  snippet: v.string(),
  score: v.number(),
});

export const pageInputValidator = v.object({
  pageNumber: v.number(),
  text: v.string(),
});

export const documentStatusValidator = v.union(
  v.literal("processing"),
  v.literal("ready"),
  v.literal("failed"),
);

export const embeddingModeValidator = v.union(
  v.literal("hashing-v1"),
  v.literal("remote"),
);
