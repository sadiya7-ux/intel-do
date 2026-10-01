import { authTables } from "@convex-dev/auth/server";
import { defineSchema, defineTable } from "convex/server";
import { Infer, v } from "convex/values";

// default user roles. can add / remove based on the project as needed
export const ROLES = {
  ADMIN: "admin",
  USER: "user",
  MEMBER: "member",
} as const;

export const roleValidator = v.union(
  v.literal(ROLES.ADMIN),
  v.literal(ROLES.USER),
  v.literal(ROLES.MEMBER),
);
export type Role = Infer<typeof roleValidator>;

const statusValidator = v.union(
  v.literal("processing"),
  v.literal("ready"),
  v.literal("failed"),
);

/**
 * Which embedding function produced a document's chunk vectors.
 * Recorded per document so the retriever can never mix vectors from two
 * different embedding spaces (swap the provider later without reindexing
 * documents that are already stored).
 */
export const embeddingModeValidator = v.union(
  v.literal("hashing-v1"),
  v.literal("remote"),
);

const sourceValidator = v.object({
  label: v.string(),
  documentId: v.id("documents"),
  fileName: v.string(),
  pageNumber: v.number(),
  snippet: v.string(),
  score: v.number(),
});

const schema = defineSchema(
  {
    // default auth tables using convex auth.
    ...authTables, // do not remove or modify

    // the users table is the default users table that is brought in by the authTables
    users: defineTable({
      name: v.optional(v.string()), // name of the user. do not remove
      image: v.optional(v.string()), // image of the user. do not remove
      email: v.optional(v.string()), // email of the user. do not remove
      emailVerificationTime: v.optional(v.number()), // email verification time. do not remove
      isAnonymous: v.optional(v.boolean()), // is anonymous. do not remove

      role: v.optional(roleValidator), // role of the user. do not remove
    }).index("email", ["email"]), // index for the email. do not remove or modify

    // Uploaded PDF documents.
    documents: defineTable({
      userId: v.string(),
      fileName: v.string(),
      fileSize: v.number(),
      pageCount: v.number(),
      status: statusValidator,
      error: v.optional(v.string()),
      chunkCount: v.optional(v.number()),
      embeddingMode: v.optional(embeddingModeValidator),
      summary: v.optional(v.string()),
    }).index("by_user", ["userId"]),

    // Raw extracted text, one row per PDF page. Page numbers are the source of
    // truth for every citation shown in the UI.
    pages: defineTable({
      documentId: v.id("documents"),
      pageNumber: v.number(),
      text: v.string(),
    }).index("by_document", ["documentId"]),

    // Page-aware retrieval chunks with a dense embedding for vector search.
    // Keep the dimension in sync with EMBEDDING_DIMS in lib/text.ts.
    chunks: defineTable({
      documentId: v.id("documents"),
      pageNumber: v.number(),
      chunkIndex: v.number(),
      text: v.string(),
      tokenCount: v.number(),
      embedding: v.array(v.float64()),
    })
      .index("by_document", ["documentId"])
      .vectorIndex("by_embedding", {
        vectorField: "embedding",
        // Keep in sync with EMBEDDING_DIMS in lib/text.ts.
        dimensions: 2048,
        filterFields: ["documentId"],
      }),

    // One conversation per signed-in user; messages reference it.
    conversations: defineTable({
      userId: v.string(),
      documentIds: v.array(v.id("documents")),
    }).index("by_user", ["userId"]),

    messages: defineTable({
      conversationId: v.id("conversations"),
      userId: v.string(),
      role: v.union(v.literal("user"), v.literal("assistant")),
      content: v.string(),
      // Assistant messages carry the retrieved sources (never model-authored).
      sources: v.optional(v.array(sourceValidator)),
    }).index("by_conversation", ["conversationId"]),
  },
  {
    schemaValidation: false,
  },
);

export default schema;
