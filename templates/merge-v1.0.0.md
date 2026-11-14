---
type: merge
title: Merge message
display: Merge
---
Written by GitGate for every merge commit.

## Fields
- `branch` (text): branch being merged
- `ci_skip` (text, optional): marker appended to skip CI

## Body
merge: {branch}{ci_skip}
