import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { sourceValidator } from "./lib/validators";
import {
  query,
  mutation,
  internalMutation,
  internalQuery,
  type QueryCtx,
  type MutationCtx,
} from "./_generated/server";

const MAX_QUESTION_LENGTH = 2000;
const MAX_HISTORY_FOR_PROMPT = 6;

async function currentUserId(ctx: QueryCtx | MutationCtx) {
  const userId = await getAuthUserId(ctx);
  if (!userId) throw new Error("Not authenticated.");
  return userId;
}

async function requireOwnConversation(
  ctx: QueryCtx | MutationCtx,
  conversationId: Id<"conversations">,
  userId: string,
) {
  const conversation = await ctx.db.get(conversationId);
  if (!conversation || conversation.userId !== userId) {
    throw new Error("Conversation not found.");
  }
  return conversation;
}

/** The signed-in user's conversation (created on first use). */
export const current = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    return await ctx.db
      .query("conversations")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .first();
  },
});

export const ensure = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await currentUserId(ctx);
    const existing = await ctx.db
      .query("conversations")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .first();
    if (existing) return existing._id;
    return await ctx.db.insert("conversations", { userId, documentIds: [] });
  },
});

export const setDocuments = mutation({
  args: { conversationId: v.id("conversations"), documentIds: v.array(v.id("documents")) },
  handler: async (ctx, args) => {
    const userId = await currentUserId(ctx);
    await requireOwnConversation(ctx, args.conversationId, userId);
    await ctx.db.patch(args.conversationId, { documentIds: args.documentIds });
  },
});

export const appendUser = mutation({
  args: { conversationId: v.id("conversations"), content: v.string() },
  handler: async (ctx, args) => {
    const userId = await currentUserId(ctx);
    await requireOwnConversation(ctx, args.conversationId, userId);
    const content = args.content.trim();
    if (!content) throw new Error("Message cannot be empty.");
    if (content.length > MAX_QUESTION_LENGTH) {
      throw new Error("Message is too long.");
    }
    return await ctx.db.insert("messages", {
      conversationId: args.conversationId,
      userId,
      role: "user",
      content,
    });
  },
});

export const listMessages = query({
  args: { conversationId: v.id("conversations"), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    const conversation = await ctx.db.get(args.conversationId);
    if (!conversation || conversation.userId !== userId) return [];

    const limit = Math.max(1, Math.min(args.limit ?? 100, 200));
    const recent = await ctx.db
      .query("messages")
      .withIndex("by_conversation", (q) =>
        q.eq("conversationId", args.conversationId),
      )
      .order("desc")
      .take(limit);
    return recent.reverse();
  },
});

export const clear = mutation({
  args: { conversationId: v.id("conversations") },
  handler: async (ctx, args) => {
    const userId = await currentUserId(ctx);
    await requireOwnConversation(ctx, args.conversationId, userId);
    const messages = await ctx.db
      .query("messages")
      .withIndex("by_conversation", (q) =>
        q.eq("conversationId", args.conversationId),
      )
      .collect();
    for (const message of messages) await ctx.db.delete(message._id);
  },
});

// ---------------------------------------------------------------------------
// Internal helpers used by the assistant action
// ---------------------------------------------------------------------------

export const getForAction = internalQuery({
  args: { conversationId: v.id("conversations") },
  handler: async (ctx, args) => await ctx.db.get(args.conversationId),
});

/** Recent transcript turns for resolving follow-up references. */
export const promptHistory = internalQuery({
  args: { conversationId: v.id("conversations"), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = Math.max(
      0,
      Math.min(args.limit ?? MAX_HISTORY_FOR_PROMPT, 20),
    );
    const recent = await ctx.db
      .query("messages")
      .withIndex("by_conversation", (q) =>
        q.eq("conversationId", args.conversationId),
      )
      .order("desc")
      .take(limit);
    return recent.reverse().map((message) => ({
      role: message.role,
      content: message.content.slice(0, 400),
    }));
  },
});

export const appendAssistant = internalMutation({
  args: {
    conversationId: v.id("conversations"),
    userId: v.string(),
    content: v.string(),
    sources: v.optional(v.array(sourceValidator)),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("messages", {
      conversationId: args.conversationId,
      userId: args.userId,
      role: "assistant",
      content: args.content,
      ...(args.sources && args.sources.length > 0
        ? { sources: args.sources }
        : {}),
    });
  },
});

export const rememberDocuments = internalMutation({
  args: {
    conversationId: v.id("conversations"),
    userId: v.string(),
    documentIds: v.array(v.id("documents")),
  },
  handler: async (ctx, args) => {
    const conversation = await ctx.db.get(args.conversationId);
    if (!conversation || conversation.userId !== args.userId) return;
    await ctx.db.patch(args.conversationId, { documentIds: args.documentIds });
  },
});
