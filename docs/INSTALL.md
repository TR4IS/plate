# Install and run Plate

## Install with Portainer

You build the image once from this folder, then start it as a stack.

**1. Pack this folder into one file.** On your Windows PC, open PowerShell in the folder that
contains `plate` and run:

```powershell
tar -cf plate.tar --exclude=node_modules --exclude=data --exclude=screenshots -C plate .
```

**2. Build the image in Portainer.**
*Images* > *Build a new image* > name it `plate:latest` > *Upload* > choose `plate.tar` >
*Build the image*. The first build downloads Node.js and takes a minute or two.

**3. Start it as a stack.**
*Stacks* > *Add stack* > name it `plate` > *Web editor* > paste the contents of
[`portainer-stack.yml`](../portainer-stack.yml) > *Deploy the stack*.

Plate is now on `http://<your-server-ip>:3000`.

If you prefer the command line, copy the `plate` folder to the server and run
`docker compose up -d --build` inside it.

> The stack keeps everything in a Docker volume called `plate-data`. If you would rather use a
> folder on the server (for example `/srv/plate:/data`), make it writable for the app first:
> `chown -R 1000:1000 /srv/plate`.

## Reach it from outside with a Cloudflare Tunnel

In the Cloudflare Zero Trust dashboard: *Networks* > *Tunnels* > your tunnel > *Public Hostname* >
*Add a public hostname*.

| Field | Value |
| --- | --- |
| Subdomain / Domain | for example `plate` . `yourdomain.com` |
| Service type | `HTTP` |
| URL | `plate:3000` if cloudflared runs in Docker on the same network, otherwise `<your-server-ip>:3000` |

**Use the `https://` address on your phone even when you are at home.** Safari only allows the
in-app camera, offline mode and "Add to Home Screen" app behaviour on a secure address. On a plain
`http://192.168…` address the app still works, but the camera button falls back to the iPhone's
own camera screen.

Because the address is public, Plate always asks for a name and password, and new accounts need an
invite code. For an extra lock in front of it you can add a Cloudflare Access policy to the hostname.

## First run

1. Open the address. The first person to arrive creates the **owner** account, so do this right
   after starting the container.
2. Answer the four setup screens (your numbers, your goal, your targets, a training plan).
3. Go to *Settings > AI connection* and paste an API key (see [below](#connecting-the-ai)).
4. To add other people, open *Settings > People*. Give them your address and the invite code;
   they tap *Create an account*. You can also create an account for someone yourself, reset a
   forgotten password, or remove a person there.

## Put it on your iPhone

1. Open your `https://` address in **Safari**.
2. Tap the **Share** button, then **Add to Home Screen**, then **Add**.
3. Open **Plate** from the Home Screen and sign in once. It stays signed in.

The first time you scan a meal, allow camera access. If iPhone keeps asking, set
*Settings > Apps > Safari > Camera* to *Allow*.

## Connecting the AI

The owner chooses one of three services in *Settings > AI connection*, pastes its key, and can
switch at any time. Press *Test* to check the key before relying on it.

| Service | Where to get a key | Default model | Notes |
| --- | --- | --- | --- |
| Claude (Anthropic) | <https://console.anthropic.com/settings/keys> | `claude-opus-5-5` | Pay per use. Sonnet 5.5 and Haiku 5.5 are in the list as faster, cheaper choices. |
| OpenAI | <https://platform.openai.com/api-keys> | `gpt-5.4` | Pay per use. Billed separately from a ChatGPT subscription. |
| Google Gemini | <https://aistudio.google.com/apikey> | `gemini-flash-latest` | Has a free tier with a small daily allowance, which Google changes from time to time. |

*Show every model this key can use* in the same screen lists what your key has access to, so you
are never stuck with a model name that has been retired.

Keys are stored on your server and are never sent to the phone. Each person may request up to 60
estimates a day (change it with `AI_DAILY_LIMIT`), which keeps the bill predictable.

Requests to Claude turn on Anthropic's server-side fallback: if a safety filter wrongly declines a
food photo, Anthropic retries it on another Claude model instead of returning an error.

## Backups and updates

**Back up** the `plate-data` volume (it holds `plate.db` and `photos/`). Each person can also save
their own data from the app: *Settings > Backup and restore*. That file contains meals, workouts,
the weight log, goals and the plan, but not meal photos.

**Update** after changing the code: repeat steps 1 and 2 of the install (new `plate.tar`, build
`plate:latest` again), then in Portainer open the stack and choose *Update the stack* with
*Re-pull image and redeploy* off. Your data stays in the volume. Phones pick up the new version by
themselves the next time the app is opened.

## Settings you can change on the server

Set these as environment variables on the container. All are optional.

| Variable | Default | What it does |
| --- | --- | --- |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY` | none | An AI key from the environment instead of typing it in the app. A key saved in the app wins. |
| `AI_PROVIDER` | first one with a key | `anthropic`, `openai` or `gemini`. The choice made in the app wins. |
| `ANTHROPIC_MODEL`, `OPENAI_MODEL`, `GEMINI_MODEL` | see table above | Model to use when none was chosen in the app. |
| `AI_DAILY_LIMIT` | `60` | AI estimates each person may request per day. |
| `PORT` | `3000` | Port the server listens on inside the container. |
| `DATA_DIR` | `/data` in Docker, `./data` otherwise | Where the database and photos are kept. |

## Running without Docker, and tests

You need Node.js 22.13 or newer (the server uses Node's built-in SQLite).

```bash
npm install
npm start        # http://localhost:3000
npm test         # API and library checks against a throwaway database
```

`http://localhost` counts as a secure address, so the in-app camera works there too.
