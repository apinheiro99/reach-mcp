---
type: commit
title: Commit message
display: Commit
---
Written by GitGate for every commit; the version lives only in the file name.
Version 2 replaces the legacy `Refs: Task #N` trailer with the canonical work item, taken from the branch-local identity.

## Fields
- `type` (text): conventional commit type
- `scope` (text): lowercase kebab-case scope
- `summary` (text): imperative summary, at most 72 characters
- `context` (text): why the change is needed
- `changes` (list): one bullet per change
- `refs` (text, required, format:work-item-v7, on:task|story): the work item of a governed branch (a free branch has none and the Work Item line is dropped), exactly `Story <uuid-v7> (#<ref>)` or `Task <uuid-v7> (#<ref>)`

## Body
{type}({scope}): {summary}

Context: {context}

{changes}

Work Item: {refs}
