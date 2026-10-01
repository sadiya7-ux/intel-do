import { motion } from "framer-motion";
import { Link } from "react-router";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { ArrowRight } from "lucide-react";

const PIPELINE = [
  {
    step: "01",
    title: "PDF upload",
    detail: "Drag-and-drop with type, size and corruption validation.",
  },
  {
    step: "02",
    title: "Text extraction",
    detail: "Page text is rebuilt from the PDF with real page numbers intact.",
  },
  {
    step: "03",
    title: "Page-aware chunking",
    detail: "Passages are split so no chunk ever crosses a page boundary.",
  },
  {
    step: "04",
    title: "Embeddings & retrieval",
    detail: "Each chunk is embedded and indexed for hybrid BM25 + vector search.",
  },
  {
    step: "05",
    title: "Relevant context",
    detail: "Only the passages that match the question reach the model.",
  },
  {
    step: "06",
    title: "Grounded generation",
    detail: "A strict system prompt forbids outside knowledge and guessing.",
  },
  {
    step: "07",
    title: "Page-level citations",
    detail: "Sources come from retrieval, never from the model's imagination.",
  },
];

const CAPABILITIES = [
  {
    title: "Grounded by construction",
    body: "Retrieval runs before generation. If nothing relevant is found, ASTRA returns the refusal line instead of an answer.",
  },
  {
    title: "Page-level citations",
    body: "Every claim links back to a real PDF page. Open the citation and read the exact passage it was built from.",
  },
  {
    title: "Multi-turn analysis",
    body: "Follow-up questions keep their references — “its limitations” resolves to the system you discussed two turns ago.",
  },
  {
    title: "Compare and search",
    body: "Structured two-document comparison tables and natural-language search across your whole document library.",
  },
];

const reveal = {
  initial: { opacity: 0, y: 16 },
  whileInView: { opacity: 1, y: 0 },
  viewport: { once: true, margin: "-60px" },
  transition: { duration: 0.5, ease: "easeOut" as const },
};

export default function Landing() {
  const { isAuthenticated } = useAuth();

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.4 }}
      className="min-h-screen bg-background"
    >
      <header className="sticky top-0 z-30 border-b border-border bg-background/95 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-5xl items-center justify-between gap-4 px-5">
          <Link
            to="/"
            className="text-sm font-semibold uppercase tracking-[0.3em] text-foreground transition-opacity hover:opacity-70"
          >
            Astra Intel
          </Link>
          <nav className="flex items-center gap-5">
            <a
              href="#pipeline"
              className="hidden text-xs text-muted-foreground transition-colors hover:text-foreground sm:block"
            >
              How it works
            </a>
            <a
              href="#capabilities"
              className="hidden text-xs text-muted-foreground transition-colors hover:text-foreground sm:block"
            >
              Capabilities
            </a>
            <Button asChild size="sm">
              <Link to="/dashboard">
                {isAuthenticated ? "Open workspace" : "Get started"}
                <ArrowRight className="size-3.5" />
              </Link>
            </Button>
          </nav>
        </div>
      </header>

      <main>
        {/* ---------------- Hero ---------------- */}
        <section className="mx-auto max-w-5xl px-5 pb-20 pt-16 sm:pt-24">
          <motion.p
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.05 }}
            className="label-xs"
          >
            Defence document intelligence
          </motion.p>

          <motion.h1
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.1 }}
            className="mt-5 max-w-3xl text-4xl font-bold leading-[1.05] tracking-tight sm:text-5xl lg:text-6xl"
          >
            Answers traced to the exact page.
          </motion.h1>

          <motion.p
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.18 }}
            className="mt-6 max-w-2xl text-base leading-7 text-muted-foreground"
          >
            Upload defence and technology PDFs. ASTRA INTEL extracts page-aware
            text, retrieves the passages that actually match your question, and
            answers with a citation for every claim — using nothing outside the
            documents you provide.
          </motion.p>

          <motion.div
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.26 }}
            className="mt-8 flex flex-wrap items-center gap-3"
          >
            <Button asChild size="lg">
              <Link to="/dashboard">
                {isAuthenticated ? "Open the workspace" : "Start analysing"}
                <ArrowRight className="size-4" />
              </Link>
            </Button>
            <Button asChild variant="outline" size="lg">
              <a href="#pipeline">See how it works</a>
            </Button>
          </motion.div>

          {/* Specimen: what an answer looks like */}
          <motion.figure
            initial={{ opacity: 0, y: 18 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.7, delay: 0.35 }}
            className="mt-14 max-w-3xl rounded-md border border-border bg-card"
          >
            <figcaption className="label-xs border-b border-border px-4 py-3">
              Astra Intel assistant
            </figcaption>
            <div className="px-4 py-5">
              <p className="label-xs">You</p>
              <p className="mt-1.5 text-sm">
                What is the detection range of the radar subsystem?
              </p>

              <p className="label-xs mt-5">Astra</p>
              <p className="mt-1.5 text-sm leading-6">
                The radar subsystem specifies a detection range of 180 nautical
                miles against surface targets, tracking up to 400 contacts
                simultaneously.{" "}
                <span className="mx-0.5 inline-block rounded-sm border border-border bg-muted px-1 py-px font-mono text-[11px]">
                  [S1]
                </span>
              </p>

              <div className="mt-4 border-l border-border pl-3">
                <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <span className="font-mono text-foreground">[S1]</span>
                  <span>Sentinel_Radar_Review.pdf</span>
                  <span className="font-mono">p. 4</span>
                </p>
                <blockquote className="mt-1.5 text-xs leading-5 text-muted-foreground">
                  “Detection range is specified as 180 nautical miles against
                  surface targets. The radar supports simultaneous tracking of
                  400 contacts…”
                </blockquote>
              </div>
            </div>
          </motion.figure>
        </section>

        <div className="mx-auto max-w-5xl px-5">
          <div className="h-px w-full bg-border" />
        </div>

        {/* ---------------- Pipeline ---------------- */}
        <motion.section
          id="pipeline"
          {...reveal}
          className="mx-auto max-w-5xl scroll-mt-20 px-5 py-16 sm:py-20"
        >
          <p className="label-xs">How it works</p>
          <h2 className="mt-4 max-w-2xl text-2xl font-bold tracking-tight sm:text-3xl">
            From a PDF to a cited answer, in seven deterministic steps.
          </h2>

          <ol className="mt-10 divide-y divide-border border-y border-border">
            {PIPELINE.map((item) => (
              <li
                key={item.step}
                className="grid grid-cols-[2.5rem_1fr] gap-x-4 gap-y-1 py-4 sm:grid-cols-[3rem_11rem_1fr]"
              >
                <span className="font-mono text-xs text-muted-foreground">
                  {item.step}
                </span>
                <span className="text-sm font-medium">{item.title}</span>
                <span className="col-span-2 text-sm leading-6 text-muted-foreground sm:col-span-1">
                  {item.detail}
                </span>
              </li>
            ))}
          </ol>
        </motion.section>

        {/* ---------------- Capabilities ---------------- */}
        <motion.section
          id="capabilities"
          {...reveal}
          className="mx-auto max-w-5xl scroll-mt-20 px-5 pb-16 sm:pb-20"
        >
          <p className="label-xs">Capabilities</p>
          <h2 className="mt-4 max-w-2xl text-2xl font-bold tracking-tight sm:text-3xl">
            Built for people who have to defend where a number came from.
          </h2>

          <div className="mt-10 grid gap-px overflow-hidden rounded-md border border-border bg-border sm:grid-cols-2">
            {CAPABILITIES.map((item) => (
              <div key={item.title} className="bg-card px-5 py-6">
                <h3 className="text-sm font-semibold tracking-tight">
                  {item.title}
                </h3>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">
                  {item.body}
                </p>
              </div>
            ))}
          </div>
        </motion.section>

        {/* ---------------- Closing CTA ---------------- */}
        <motion.section {...reveal} className="border-t border-border">
          <div className="mx-auto flex max-w-5xl flex-col gap-6 px-5 py-16 sm:flex-row sm:items-end sm:justify-between sm:py-20">
            <div className="max-w-xl">
              <h2 className="text-2xl font-bold tracking-tight sm:text-3xl">
                Put a document in front of it.
              </h2>
              <p className="mt-3 text-sm leading-6 text-muted-foreground">
                Upload a PDF, ask a question, and check the page yourself. If
                the document does not say it, ASTRA INTEL says so.
              </p>
            </div>
            <Button asChild size="lg">
              <Link to="/dashboard">
                {isAuthenticated ? "Open the workspace" : "Get started"}
                <ArrowRight className="size-4" />
              </Link>
            </Button>
          </div>
        </motion.section>
      </main>

      <footer className="border-t border-border">
        <div className="mx-auto flex max-w-5xl flex-col gap-2 px-5 py-6 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
          <span className="font-medium uppercase tracking-[0.18em] text-foreground">
            Astra Intel
          </span>
          <span>AI-Powered Defence Document Intelligence · Source-traced analysis</span>
        </div>
      </footer>
    </motion.div>
  );
}
