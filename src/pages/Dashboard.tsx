import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { Link, useNavigate } from "react-router";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useAuth } from "@/hooks/use-auth";
import type { ActiveSource, SourceDto } from "@/lib/astra";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { UploadZone } from "@/components/astra/UploadZone";
import { DocumentLibrary } from "@/components/astra/DocumentLibrary";
import { AssistantView } from "@/components/astra/AssistantView";
import { SearchView } from "@/components/astra/SearchView";
import { CompareView } from "@/components/astra/CompareView";
import { SourcePanel } from "@/components/astra/SourcePanel";
import { LogOut, MessageSquare, Scale, Search } from "lucide-react";

type View = "assistant" | "search" | "compare";

const NAV_ITEMS: Array<{ id: View; label: string; icon: typeof Search }> = [
  { id: "assistant", label: "Assistant", icon: MessageSquare },
  { id: "search", label: "Search", icon: Search },
  { id: "compare", label: "Compare", icon: Scale },
];

export default function Dashboard() {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();

  const documents = useQuery(api.documents.list);
  const conversation = useQuery(api.conversations.current);
  const ensureConversation = useMutation(api.conversations.ensure);
  const messages = useQuery(
    api.conversations.listMessages,
    conversation ? { conversationId: conversation._id, limit: 100 } : "skip",
  );

  const [view, setView] = useState<View>("assistant");
  const [selectedIds, setSelectedIds] = useState<Id<"documents">[]>([]);
  const [focusedId, setFocusedId] = useState<Id<"documents"> | null>(null);
  const [activeSource, setActiveSource] = useState<ActiveSource | null>(null);

  const docs = documents ?? [];

  // Newly indexed documents join the retrieval scope automatically, while an
  // explicit user deselection is remembered.
  const knownReady = useRef(new Set<string>());
  const deselected = useRef(new Set<string>());

  useEffect(() => {
    if (!documents) return;

    const readyIds = documents
      .filter((doc) => doc.status === "ready")
      .map((doc) => doc._id as string);
    const newlyReady = readyIds.filter((id) => !knownReady.current.has(id));
    for (const id of readyIds) knownReady.current.add(id);

    const toAdd = newlyReady.filter((id) => !deselected.current.has(id)) as Id<
      "documents"
    >[];
    if (toAdd.length > 0) {
      setSelectedIds((previous) => Array.from(new Set([...previous, ...toAdd])));
    }

    setFocusedId((previous) =>
      previous && documents.some((doc) => doc._id === previous)
        ? previous
        : (documents[0]?._id ?? null),
    );
  }, [documents]);

  const scopedReadyIds = useMemo(
    () =>
      docs
        .filter((doc) => selectedIds.includes(doc._id) && doc.status === "ready")
        .map((doc) => doc._id),
    [docs, selectedIds],
  );

  const latestSources: SourceDto[] = useMemo(() => {
    const transcript = messages ?? [];
    for (let index = transcript.length - 1; index >= 0; index--) {
      const message = transcript[index];
      if (
        message.role === "assistant" &&
        message.sources &&
        message.sources.length > 0
      ) {
        return message.sources;
      }
    }
    return [];
  }, [messages]);

  const handleToggle = (documentId: Id<"documents">) => {
    setSelectedIds((previous) => {
      const isSelected = previous.includes(documentId);
      if (isSelected) deselected.current.add(documentId as string);
      else deselected.current.delete(documentId as string);
      return isSelected
        ? previous.filter((id) => id !== documentId)
        : [...previous, documentId];
    });
  };

  const handleUploaded = (documentId: Id<"documents">) => {
    setFocusedId(documentId);
    setView("assistant");
  };

  const handleOpenSource = (source: ActiveSource) => {
    setActiveSource({
      documentId: source.documentId,
      fileName: source.fileName,
      pageNumber: source.pageNumber,
    });
  };

  const handleSignOut = async () => {
    await signOut();
    navigate("/");
  };

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-30 flex h-14 items-center justify-between gap-4 border-b border-border bg-background px-4 sm:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <Link
            to="/"
            className="flex shrink-0 items-center gap-2.5 transition-opacity hover:opacity-70"
          >
            <span
              className="flex size-5 items-center justify-center border border-foreground"
              aria-hidden="true"
            >
              <span className="size-1.5 bg-foreground" />
            </span>
            <span className="text-sm font-semibold uppercase tracking-[0.3em] text-foreground">
              Astra Intel
            </span>
          </Link>
          <span className="hidden h-4 w-px bg-border sm:block" aria-hidden="true" />              <span className="hidden truncate font-mono text-[11px] text-muted-foreground sm:block">
                AI-Powered Defence Document Intelligence
              </span>
        </div>

        <div className="flex items-center gap-3">
          <span className="hidden max-w-[220px] truncate text-xs text-muted-foreground md:block">
            {user?.email ?? user?.name ?? "Signed in"}
          </span>
          <Button variant="ghost" size="sm" onClick={() => void handleSignOut()}>
            <LogOut className="size-3.5" />
            Sign out
          </Button>
        </div>
      </header>

      <div className="grid grid-cols-1 lg:h-[calc(100dvh-3.5rem)] lg:grid-cols-[260px_minmax(0,1fr)_300px] xl:grid-cols-[280px_minmax(0,1fr)_340px]">
        {/* Sidebar: upload, library, navigation */}
        <aside className="flex flex-col gap-6 border-b border-border px-4 py-6 lg:overflow-y-auto lg:border-b-0 lg:border-r">
          <UploadZone onUploaded={handleUploaded} />

          <section>
            <div className="mb-2 flex items-center justify-between gap-2">
              <h2 className="label-xs">Document library</h2>
              <span className="text-[11px] text-muted-foreground">
                {docs.length} file{docs.length === 1 ? "" : "s"}
              </span>
            </div>
            <DocumentLibrary
              documents={docs}
              selectedIds={selectedIds}
              focusedId={focusedId}
              onToggle={handleToggle}
              onFocus={setFocusedId}
            />
          </section>

          <nav aria-label="Workspace">
            <h2 className="label-xs mb-2">Workspace</h2>
            <ul className="space-y-1">
              {NAV_ITEMS.map((item) => {
                const Icon = item.icon;
                const active = view === item.id;
                return (
                  <li key={item.id}>
                    <button
                      type="button"
                      onClick={() => setView(item.id)}
                      className={cn(
                        "relative flex w-full cursor-pointer items-center gap-2.5 rounded-sm px-3 py-2 text-sm transition-colors",
                        active
                          ? "bg-muted font-medium text-foreground"
                          : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
                      )}
                      aria-current={active ? "page" : undefined}
                    >
                      {active && (
                        <span
                          className="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 bg-foreground"
                          aria-hidden="true"
                        />
                      )}
                      <Icon className="size-4" />
                      {item.label}
                    </button>
                  </li>
                );
              })}
            </ul>
          </nav>
        </aside>

        {/* Main workspace */}
        <main className="min-w-0 lg:overflow-y-auto">
          {view === "assistant" && (
            <AssistantView
              documents={docs}
              selectedIds={selectedIds}
              focusedId={focusedId}
              messages={messages}
              conversationId={conversation?._id ?? null}
              ensureConversation={async () => await ensureConversation()}
              onOpenSource={handleOpenSource}
            />
          )}
          {view === "search" && (
            <SearchView
              documentIds={scopedReadyIds}
              onOpenSource={handleOpenSource}
            />
          )}
          {view === "compare" && <CompareView documents={docs} />}
        </main>

        {/* Source panel */}
        <aside className="border-t border-border lg:overflow-y-auto lg:border-t-0 lg:border-l">
          <SourcePanel
            activeSource={activeSource}
            latestSources={latestSources}
            onOpenSource={handleOpenSource}
            onClearActive={() => setActiveSource(null)}
          />
        </aside>
      </div>
    </div>
  );
}
