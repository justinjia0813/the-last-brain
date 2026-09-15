# The Last Brain 0.1.0

First public test release: read-only vault conversations, local chat history, source excerpts, and reviewed memories.

## Install

Download `the-last-brain-0.1.0.zip` below. Extract the `the-last-brain` folder into your vault's `.obsidian/plugins/`, then enable **The Last Brain** in Obsidian's community plugin settings. Requires **Obsidian 1.11.4+**.

The individual `main.js`, `manifest.json`, and `styles.css` assets are also available for manual or community-directory installation.

## Setup

Provide an OpenAI-compatible endpoint, model name, and key in the settings. Save the key, enable sending context, then open the chat ribbon icon. The interface is currently in Chinese.

## What to test

- Ask about a specific topic from your Markdown notes and inspect the cited excerpts.
- Reload the plugin and check that conversation history remains available.
- Generate a memory draft, review it, confirm it, and ask a related question in a new conversation.

Only plugin-owned history and memory data are written. Notes and attachments are read-only. Selected context is sent to your chosen model provider only on your action; provider fees may apply.

## Validation and limits

Ten automated checks, TypeScript checks, and the build pass. Native macOS Obsidian tests with a synthetic local model covered chat, source navigation, exclusions, memory reuse, failure/retry, persistence, and deletion. No note writes occurred. Real provider response quality and mobile behavior have not been tested. Retrieval currently uses Markdown keyword matching, not semantic search.

This GitHub release is ready for testing; it is not yet approved or listed in the Obsidian community directory.
