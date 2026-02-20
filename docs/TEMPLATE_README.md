---
uri: klappy://docs/template-readme
title: "README Index Template"
audience: docs
exposure: hidden
tier: 3
voice: neutral
stability: stable
tags: ["template", "readme", "index", "oddkit"]
---

# README Index Template

> Template for folder README.md files that describe a folder's purpose. READMEs do not contain contents tables — oddkit provides folder listings dynamically. A README answers "what is this folder and why does it exist?" oddkit answers "what files are in this folder?"

## Summary — READMEs Describe, oddkit Lists

Every navigable folder should have a README.md that describes its purpose, audience, and relationships. This enables agents to understand a folder's role (~200 tokens) without reading every file.

READMEs do **not** contain contents tables. Consumers that need a file listing query oddkit by path prefix. This ensures that any document with valid frontmatter is immediately discoverable without any registration step.

-----

## When to Use This Template

Create a README when:

- A folder contains 3+ files
- The folder is navigable (not internal/generated)
- Agents or humans need to understand the folder's purpose

Do NOT create a README for:

- Generated/derived folders (`public/_compiled/`, `dist/`)
- Single-file folders (promote the file to parent instead)
- Internal tooling folders (`.git/`, `node_modules/`)

-----

## Template Structure

````markdown
---
uri: klappy://<path>
title: "Folder Name"
audience: docs | canon | public
exposure: nav
tier: 1 | 2
voice: neutral
stability: stable | evolving
tags: ["folder", "index"]
---

# Folder Name

> One-line description of what this folder contains and why it exists.

## Description

1-2 paragraph overview of the folder's purpose. What kind of content
lives here? Who is the intended audience? How does this folder relate
to the broader structure?

-----

## See Also

- [Related Folder](/path/to/folder/) — Brief description
- [Related Doc](/path/to/doc.md) — Brief description
````

-----

## What READMEs Contain

- **Title and blockquote** — What this folder is and its stance
- **Metadata** — URI, audience, exposure, tags, relationships
- **Description** — Purpose, audience, relationship to broader structure
- **See Also** — Cross-references to related folders or docs

-----

## What READMEs Do Not Contain

- **Contents tables** — No file listings, no `| File | Description |` tables

Consumers that need folder listings query oddkit:

- **oddkit search** with path-scoped query returns all indexed documents in a directory
- **oddkit catalog** returns the full inventory, filterable by path prefix client-side
- Both return title, URI, blockquote, tags, and score — everything a listing needs

-----

## How New Documents Become Discoverable

A new document becomes discoverable by having valid frontmatter. At minimum:

- `title` — Names the concept and its stance
- `uri` — The canonical `klappy://` path
- A blockquote (`>` line after the title) — The compressed argument

oddkit indexes automatically. No README update needed. No registration step. No hook to fire.

If a document lacks valid frontmatter, it does not appear in oddkit's index. This is enforcement by visibility: the Writing Canon requirement that every document must be actionable at every extraction tier is enforced by the index itself.

-----

## See Also

- [Writing Canon](/canon/meta/writing-canon.md) — Progressive disclosure requirements for all documents
- [Article Template](/docs/TEMPLATE.md) — Template for individual documentation articles
- [Planning: README Indexes Eliminated](/docs/planning/auto-generated-indexes.md) — Decision record for this approach
