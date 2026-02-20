---
uri: klappy://docs/planning/auto-generated-indexes
title: "Planning: README Indexes Are Eliminated, Not Auto-Generated"
audience: docs
exposure: nav
tier: 2
voice: neutral
stability: evolving
tags: ["planning", "indexes", "readme", "frontmatter", "derived", "ritual-smell", "oddkit", "dynamic"]
epoch: E0005
date: 2026-02-19
derives_from: "docs/planning/automated-changelog.md, canon/values/axioms.md"
complements: "docs/TEMPLATE_README.md, odd/ledger/epistemic-ledger.md"

---

# Planning: README Indexes Are Eliminated, Not Auto-Generated

> oddkit already indexes every document with valid frontmatter. Consumers — the website, agents, rendering layers — should query oddkit dynamically for folder listings, not read static tables from README files. READMEs retain their purpose: folder description, audience, blockquote, metadata. The contents table is not their job. The correct architecture: oddkit is the index, READMEs are documentation, consumers query dynamically.

-----

## Summary — oddkit Is the Index, READMEs Are Documentation

The original problem was real: hand-maintained README index tables are brittle rituals that fail silently. Files get committed but never linked because someone forgot to update a table.

The tempting fix — auto-generating tables via commit hooks or build scripts — solves the symptom but preserves the anti-pattern. It still puts a derived artifact in the source tree. It still depends on a hook firing. It still maintains a copy of data that already exists in oddkit's index.

The correct fix is architectural: there is no table to maintain — static or generated. oddkit indexes every `.md` file with valid frontmatter. Any consumer that needs a folder listing queries oddkit by path prefix. The README provides folder-level documentation (what is this folder, who is the audience, what kind of content lives here). The listing comes from oddkit at query time.

This is the same insight as the changelog: the source of truth already exists. Stop maintaining copies.

-----

## What Changes

**READMEs keep:** Title, blockquote, metadata, folder description, audience context, "See Also" cross-references. Everything that describes the folder's *purpose* and *relationships*.

**READMEs lose:** Contents tables. Any hand-maintained listing of individual files. The README is documentation about the folder, not an inventory of its contents.

**Consumers change:** Any rendering surface that needs to display a folder listing queries oddkit instead of reading a table from the README. Two approaches:

1. **oddkit search by path prefix** — `oddkit_search` with a query scoped to a directory returns all indexed documents in that path. Results include title, URI, blockquote snippet, and tags.

2. **oddkit catalog** — `oddkit_catalog` returns the full document inventory with categories. Can be filtered client-side by path prefix.

Either approach returns live data from the same index that powers search, ensuring that if oddkit can find a document, the listing shows it.

-----

## Why Not Auto-Generate

The tempting alternative is to auto-generate the contents table — a script that scans frontmatter and writes the table into the README, triggered by commit hooks or CI. This is wrong for three reasons:

**Derived artifacts in the source tree are lies waiting to happen.** A generated table in a committed file looks authoritative. If the generation doesn't run (new machine, CI environment, skipped hook), the table silently drifts from reality. The failure mode is the same as the manual table — just less frequent.

**It's a copy of data that already exists.** oddkit indexes every document with frontmatter. A generated table is a static snapshot of data that oddkit serves dynamically. Maintaining the copy — even automatically — creates a sync problem that doesn't need to exist.

**It adds machinery that doesn't need to exist.** A script that parses frontmatter, walks directories, handles sort modes, and manages file markers is real code that needs maintenance. oddkit already does all of this. The script would be redundant infrastructure.

-----

## What Consumers Need to Know

**If you're building a rendering surface** (website, dashboard, navigation UI): query oddkit for folder listings. Don't read README tables.

**If you're an agent scanning folder structure:** READMEs still describe the folder's purpose and audience — read them for orientation. For the actual file listing, use oddkit search or catalog.

**If you're adding a new document:** give it valid frontmatter (at minimum: `title`, `uri`, and a blockquote). oddkit indexes it automatically. No registration step. No table update. No extra work.

**If you want sorted listings:** sort client-side after querying oddkit. Frontmatter fields (`date`, `title`, decision ID patterns) provide the sort keys. The sort order is a rendering concern, not a storage concern.

-----

## Constraints

READMEs must still exist for navigable folders with 3+ files. They provide folder-level orientation that a file listing alone cannot. But they document the folder — they don't index it.

Documents without valid frontmatter do not appear in oddkit's index. This is enforcement by visibility: if you want your document discoverable, give it a title and a blockquote. This is consistent with the Writing Canon requirement that every document must be actionable at every extraction tier.

This decision is reversible — READMEs can always get tables back if oddkit proves unreliable as an index source. But oddkit has been the primary discovery mechanism for 368+ documents across the entire canon, so this is a bet on proven infrastructure.

-----

## Migration

1. Remove hand-maintained contents tables from existing READMEs (e.g., `writings/README.md`, `canon/methods/README.md`, `docs/decisions/README.md`).
2. Keep README folder descriptions, blockquotes, metadata, and "See Also" sections intact.
3. Update `docs/TEMPLATE_README.md` to reflect that contents tables are not authored — consumers query oddkit.
4. Update odd.klappy.dev rendering layer to query oddkit for folder listings where it currently reads README tables.

-----

## Precedent

From `docs/planning/automated-changelog.md`: git already stores the changelog data. Manual maintenance was redundant.

From this decision: oddkit already stores the index data. Static tables — manual or generated — are redundant.

Same pattern. Same fix. One step further: don't automate the copy, eliminate the copy.
