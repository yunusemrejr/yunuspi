# Email and outreach

The harness ships one email owner: `extensions/agentmail.ts`. It talks to the
[AgentMail](https://docs.agentmail.to) REST API (v0) with an API key that is read
from the process environment at call time. No key is written to disk, logged or
echoed back in tool output.

## Configuration

| Variable | Required | Meaning |
| --- | --- | --- |
| `AGENTMAIL_API_KEY` | yes | Bearer token for the AgentMail API. |
| `AGENTMAIL_INBOX_ID` | recommended | Default sender inbox (usually the sending address). The tools fail with an explicit `inboxId` error when neither this nor an explicit `inboxId` is given. |
| `AGENTMAIL_BASE_URL` | no | Endpoint override, e.g. `https://api.agentmail.eu`. Default `https://api.agentmail.to`. |

Export the variables in the shell that starts Pi, or through your service
manager. Never commit them, and never place them in a file that is published:

```sh
export AGENTMAIL_API_KEY=<agentmail-api-key>
export AGENTMAIL_INBOX_ID=you@your-domain.example
```

`agentmail_status` reports whether the key is visible and which inboxes it can
use, so a session can verify configuration before sending anything.

## Tools

| Tool | Purpose |
| --- | --- |
| `agentmail_status` | Configuration check plus the inbox list the key can reach. Read-only. |
| `agentmail_send` | Send one message from an inbox. Requires a subject and a text and/or HTML body. |
| `agentmail_messages` | List recent messages with compact rows (ids, from/to, subject, time, labels, preview) and filters such as labels, sender, recipients or subject. |
| `agentmail_search` | Full-text relevance search across sender, recipients, subject and body, with per-field match highlights. |
| `agentmail_message` | Read one message body by id; HTML is opt-in because it is token-heavy. |

Sending is explicit and immediate. The tools bound recipients (50), subject
length, body size and request size, and reject CR/LF in subjects and addresses so
a value cannot inject extra headers. Attachments are not exposed; use the
AgentMail API directly for those.

List and search results carry `nextPageToken` when more pages exist: pass it
back as `pageToken` and follow every page before concluding. Reads retry once
on 429/5xx (honoring a small `Retry-After`); sends never retry automatically,
so a failed send is reported exactly once.

## Outreach conduct

Email is a shared channel with legal and reputational consequences; the tools
enforce limits, not judgement.

- Send only to addresses verified on a real page or supplied by the user.
  Search snippets hallucinate addresses.
- Keep a suppression list of bounces and opt-outs, and check it before a
  campaign. Never re-send to an address that asked to stop.
- Individualize each message; do not pad a campaign to a requested count.
- Use an honest sender identity and include an opt-out line.
- Commercial mail may require a physical postal address (for example CAN-SPAM).
  If the sender has none, surface that gap instead of inventing one.
- On `rejected`, `unauthorized` or validation errors, fix the account or input
  before retrying. Do not loop on sends; `rate_limited` and `server` failures are
  the only retryable kinds.

## API notes

- Send: `POST /v0/inboxes/{inbox_id}/messages/send`, body
  `{to, cc, bcc, reply_to, subject, text, html, labels}`; a success returns
  `message_id` and `thread_id`.
- List: `GET /v0/inboxes/{inbox_id}/messages` with `limit`, `page_token`,
  `labels`, `from`, `to`, `subject`, `ascending`, `include_spam`,
  `include_trash`. Prefer the `preview` field over per-message detail calls
  for triage.
- Search: `GET /v0/inboxes/{inbox_id}/messages/search` with `q`, `limit`,
  `page_token`, `before`, `after`. Spam, trash, blocked and unauthenticated
  mail are always excluded by the API.
- Errors carry `code`, `message`, `fix` and `docs`; the tools surface those
  fields instead of the raw body.
- Transport is shared with `http_request` (bounded body, no redirect following,
  cookie stripping, SSRF guard), so there is one HTTP implementation in the
  harness.
