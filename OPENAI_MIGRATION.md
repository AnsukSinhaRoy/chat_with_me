# OpenAI migration notes

This build removes Gemini from the runtime chat path and uses OpenAI instead.

## Backend Vercel environment variables

Set these on the backend project:

```text
OPENAI_API_KEY=sk-...
APP_MODE=quota_saver
CORS_ORIGINS=https://chat-with-me-kohl.vercel.app
OPENAI_CHAT_MODEL=gpt-4.1-mini
OPENAI_TRANSCRIBE_MODEL=gpt-4o-mini-transcribe
```

Optional fallback override:

```text
OPENAI_MODEL_CANDIDATES=gpt-4.1-mini,gpt-4.1-nano
```

Do not put `OPENAI_API_KEY` in the frontend project. It must stay server-side.

## Frontend Vercel environment variables

Set these on the frontend project:

```text
NEXT_PUBLIC_API_BASE_URL=https://chat-with-ansuk.vercel.app
NEXT_PUBLIC_APP_MODE=quota_saver
```

`BACKEND_URL` is not used by the current frontend code. Keeping it will not hurt, but it is unnecessary.

## Important

Your ChatGPT Plus subscription does not power API calls. The deployed backend needs a separate OpenAI API key with API billing enabled.

The old Gemini key should be rotated or deleted because it was pasted into a chat message.
