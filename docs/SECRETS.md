# Configuring Cloudflare secrets

The weather-source configuration references secrets via placeholders such as:

```json
"apikey": "${WEATHER_COM_API_KEY}"
```

The actual secret value is **never** stored in the JSON configuration. It must be supplied as a Cloudflare Worker **secret** (or a plain text environment variable in local dev).

## Production (deploy)

Use Wrangler to set the secret for the deployed Worker:

```bash
npx wrangler secret put WEATHER_COM_API_KEY
```

You will be prompted to paste the value (or pass it via `--`/stdin in CI).

Set the manual-trigger secret the same way:

```bash
npx wrangler secret put COLLECTOR_TRIGGER_SECRET
```

## Local development

Create a `.dev.vars` file in the project root (git-ignored):

```text
WEATHER_COM_API_KEY=your-key-here
COLLECTOR_TRIGGER_SECRET=some-token
```

`wrangler dev` reads `.dev.vars` automatically. Do not commit this file.

## Required bindings

| Binding | Purpose | Required? |
| --- | --- | --- |
| `WEATHER_COM_API_KEY` | Weather.com PWS API key | Yes, for the default source |
| `COLLECTOR_TRIGGER_SECRET` | Protects the manual fetch trigger | Recommended |

Any other secret referenced by other sources (e.g. `${SOME_API_TOKEN}`) must also be added.

## Security notes

- Never commit API keys or tokens.
- Logs never print request headers, URLs containing secrets, or the placeholder values.
- The manual trigger endpoint returns `403 Forbidden` if `COLLECTOR_TRIGGER_SECRET` is not set, so an unconfigured secret leaves the endpoint locked down.