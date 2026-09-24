



https://github.com/user-attachments/assets/ba88a91b-9049-439f-9bde-70470f907fce


AI Chat for HFS — Plugin Overview & User Manual
Overview
AI Chat is an admin-grade chat UI plugin for HFS (HTTP File Server). It provides a full-featured, multi-model AI chat interface that runs directly inside your HFS instance, with backend-only API key storage, streaming responses, and persistent conversation history.

Version: 6.2
Requires: HFS API 8.87+
Repository: Hug3O/Ai-chat

Key Features
Multi-model support — Configure any number of OpenAI /v1/chat/completions-compatible endpoints (DeepSeek, OpenAI, Ollama, OpenRouter, etc.)

Per-model isolation — Each conversation is tied to a model; filter and search by model

Streaming responses — Real-time token streaming with a live "Thinking" indicator

Markdown rendering — Headings, lists, tables, code blocks, inline code, links, blockquotes, bold/italic/strikethrough

Reasoning display — Collapsible reasoning/thinking output (for models that support it)

Cross-device realtime sync — Conversations, streaming state, and edits propagate to all open tabs/devices via SSE

Activity-based sorting — Most recently active conversations float to the top; starred chats pinned above

Full-text search — Search across all conversation titles and message bodies, with match highlighting and jump-to-match

Paginated pair-based storage — Messages stored as Q&A pairs in numbered files; supports "Load older messages"

Daily snapshot txt backup — Human-readable .txt backup per conversation per day, with configurable retention

Message actions — Retry, edit & resend, regenerate, delete (per-message or per-pair), copy, print (single or Q&A pair)

Optional web search — Per-model toggle to enable web_search/enable_search parameters

Guest access control — Allow or restrict non-admin users; per-model "login only" and "free" flags

Fullscreen mode — Expand the chat to fill the viewport

Font size adjustment — A- / A+ controls in the sidebar

Mobile-friendly — Responsive layout with visual viewport handling for on-screen keyboards

Installation
Place the plugin folder (containing plugin.js, main.js, style.css) into your HFS plugins directory.

Restart HFS or reload plugins.

Open the plugin's configuration in the HFS admin panel.

Configure at least one model in the Model List.

Set a Default Model ID matching one of your configured models.

Click the AI Chat button in the HFS menu bar to open the chat.

Configuration Reference
Model List (modelList)
An array of model definitions. Each entry has:

Field	Description
id	Unique identifier (used internally and in the default model setting)
label	Display name shown in the UI
baseUrl	API base URL without /v1 (e.g. https://api.deepseek.com)
apiKey	API key — stored backend-only, never sent to the frontend
modelName	The model field sent to the API (e.g. deepseek-chat)
supportsSearch	Enable web search parameters for this model
isFree	Mark as free (shown in the UI)
loginOnly	Only logged-in users (not guests) may use this model
Default entry: DeepSeek Chat at https://api.deepseek.com.

General Settings
Setting	Default	Description
defaultModelId	deepseek-chat	Model used when none is selected
systemPrompt	You are a helpful assistant.	System prompt prepended to every request
temperature	0.7	Sampling temperature (0–2)
maxTokens	4096	Max output tokens
maxContextMessages	100	Max number of prior messages included as context
enableStream	true	Stream responses token-by-token
apiTimeout	300	Request timeout in seconds
pageSize	200	Pairs loaded per page
showReasoning	true	Show collapsible reasoning blocks
allowGuest	true	Allow non-admin users to use the chat
backupConversations	true	Auto-save daily .txt snapshots
backupDays	30	Backup retention in days
backupPurgeOnDelete	false	Also delete historical backups when a conversation is deleted
Using the Chat
Opening & Closing
Click AI Chat in the HFS menu bar to toggle the panel.

Click the × in the top-right of the panel to close it.

Click the title Ⓐ AI-Chat + to toggle fullscreen.

Creating a Conversation
Click + New Chat in the sidebar, or simply type a message — a new conversation is created automatically on first send.

Sending Messages
Type in the input box and press Enter to send.

Shift+Enter inserts a newline.

The input auto-grows up to 140px.

Managing Conversations (Sidebar)
Action	How
Switch conversation	Click a conversation in the list
Rename	Double-click, or long-press (mobile)
Star / pin	Click the ☆ / ★ button
Delete	Click the × button (confirmation required)
Search all	Click the Ⓢ button in the sidebar header
Message Actions
Right-click (desktop) or long-press (mobile) a message bubble to open the context menu:

Copy — Copy message content to clipboard

Edit — Edit a user message and resend (truncates all later pairs)

Resend — Retry a failed user message

Regenerate — Re-run the assistant reply for a given question

Print Q&A — Print the full question + answer pair

Print Question / Print Answer — Print a single message

Delete — Delete the message (deleting a user message removes the whole pair; deleting an assistant message removes only the answer)

Search
Two search modes:

Global search (sidebar Ⓢ button) — Searches titles and message bodies across all conversations. Results show match counts and jump to the conversation.

In-conversation find — When global search is active, matching text in the current conversation is highlighted. Use ▲ / ▼ to navigate between matches.

Web Search Toggle
If the current model supports web search (supportsSearch: true), a Web Search toggle appears in the header. When enabled, the backend adds web_search: true and enable_search: true to the request payload.

Model Switching
Use the dropdown in the header to switch models. The change applies to the next reply (the current conversation's model metadata is not altered unless you send a new message with the new model selected).

Font Size
Use A- / A+ in the sidebar header to adjust the chat font size (14–24px). The preference is saved in localStorage.

Stop Generation
While streaming, the Send button becomes a ■ Stop button. Clicking it stops local streaming display (the backend stream continues in the background until completion).

Data Storage & Backup
Conversation Storage
Conversations are stored under storage/conversations/:

text
conversations/
├── _index.json              # Conversation index (metadata list)
└── <convId>/
    ├── meta.json            # Conversation metadata
    └── pairs/
        ├── 0001.json        # Q&A pair 1
        ├── 0002.json        # Q&A pair 2
        └── ...
Each pair file contains { q: {...}, a: {...}, ts, error? }.

Legacy messages.json files are automatically migrated on first access.

Streaming State
Active stream snapshots are written to storage/streaming/<convId>.json and removed when the stream ends. This allows other devices to pick up an in-progress stream.

Backup
When backupConversations is enabled, a human-readable .txt snapshot is written to:

text
storage/backup/<YYYY-MM-DD>/<convId>.txt
storage/backup/<YYYY-MM-DD>/<convId>.meta.json
One snapshot per conversation per day (re-written on each change that day).

Writes are atomic (temp file + rename).

Old day-folders are cleaned up on startup and every 6 hours based on backupDays.

Set backupPurgeOnDelete: true to also remove historical backups when a conversation is deleted.

Access Control
Admin (admin user) — Full access to all models and conversations.

Logged-in users — Access unless a model is marked loginOnly and they are not logged in.

Guests — Access only if allowGuest is true. Models marked loginOnly are hidden.

The /~/api/chat/check endpoint returns the current user's permissions and the list of models they may use.

API Endpoints (Backend)
All endpoints are under /~/api/chat/:

Method	Path	Purpose
GET	check	Access check + model list for current user
GET	conversations	List conversations (optional ?modelId=)
POST	conversation	Create a new conversation
GET	conversation	Get conversation metadata + paginated pairs
GET	pair	Get a single pair by index
GET	stream-state	Get active/persisted stream state
GET	search	Full-text search across conversations
POST	conversation/delete	Delete a conversation
POST	conversation/rename	Rename a conversation
POST	conversation/toggle-star	Star / unstar
POST	conversation/clear-all	Delete all conversations (optional ?modelId=)
POST	send	Send a message
POST	retry	Retry a failed message
POST	regenerate	Regenerate an assistant reply
POST	edit-resend	Edit a user message and resend
POST	pair/delete	Delete a single pair or assistant-only
Realtime Events (SSE)
The backend emits events on the chat channel via api.notifyClient:

Event	Payload
conversationCreated	{ meta }
conversationDeleted	{ id }
conversationRenamed	{ id, title, meta }
conversationStarred	{ id, starred, meta }
allCleared	{ modelId }
streamingStarted	{ conversationId }
streamingEnded	{ conversationId }
streamDelta	{ conversationId, seq, delta, reasoningDelta, pairIndex }
userMessage	{ conversationId, message, meta, pairIndex }
assistantMessage	{ conversationId, message, meta, pairIndex }
messageFailed	{ conversationId, pairIndex, error }
userMessageRetried	{ conversationId, pairIndex, ts }
assistantRegenerating	{ conversationId, pairIndex, ts }
userMessageEdited	{ conversationId, pairIndex, content, ts, meta }
pairsTruncated	{ conversationId, fromIndex }
pairDeleted	{ conversationId, pairIndex, withUser, meta }
Tips & Notes
API keys are backend-only. They are never exposed to the frontend or logged in client-visible responses.

Streaming state syncs across devices. If you open the same conversation on two devices, both will see the live stream.

Only one stream per conversation. Sending a second message while a response is generating returns HTTP 409.

Context window is approximated by maxContextMessages / 2 pairs before the current one.

Failed messages are marked with failed: true on the user message and an error field on the pair. Use Retry or Resend to recover.

Backups are per-day snapshots — old versions remain recoverable until retention expires (unless purged).

Reasoning content (reasoning_content) is captured from the stream and stored on the assistant message when present.

Mobile: the panel handles the on-screen keyboard via visualViewport to keep the input visible.

Troubleshooting
Symptom	Likely Cause / Fix
"Chat is not available" toast	/~/api/chat/check failed or allowed: false. Check allowGuest and login state.
"Model not configured"	The selected model ID doesn't exist in modelList, or defaultModelId is invalid.
"API Key not configured"	The selected model has an empty apiKey.
"Model not allowed for this user"	Model is loginOnly and user is a guest.
"Upstream 401/403"	Invalid API key or the endpoint rejected the request.
"Upstream 429"	Rate limited by the upstream provider.
Empty response	The model returned no content and no reasoning — marked as failed.
Stream stops mid-way	Network error or timeout (apiTimeout). The partial content is saved.
Search finds nothing	Search is case-insensitive but matches exact substrings. Try shorter terms.
File Structure
text
plugin.js     # Backend: config schema, storage, API routes, completion runner
main.js       # Frontend: React UI, markdown renderer, SSE handling, state
style.css     # Styles: panel, sidebar, messages, mobile, print, tables
License & Credits
Author: Hug3O


Built for HFS (HTTP File Server) with React and the HFS plugin API.
